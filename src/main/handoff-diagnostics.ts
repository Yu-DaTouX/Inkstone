/**
 * 阶段诊断事件的落盘与读回（实施-14 F0）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么单独一个文件
 * ══════════════════════════════════════════════════════════
 * 交接 / 目标续接的关键状态本来就有三份（`goals.json`、`handoffs.json`、
 * `handoff-transaction/`），但它们记的都是**当前事实**，不是**过程**：
 * 「资格没过」不会留下任何痕迹，「结果对不上」也只是静默 return。
 * 这一份专门记过程，形状是 JSONL（一行一条，追加写，坏了只坏一行）。
 *
 * ── 三条设计约束 ──
 *   ① **写失败不能抛**（诊断坏了不能拖垮交接本身）；
 *   ② **有界**：内存只保 `limit` 条，落盘也**整份写内存里那些** ——
 *      不做「追加 + 定期重写」是因为那两个动作会让已被淘汰的旧事件又被写回去，
 *      行数随调用顺序漂。诊断事件的频率很低（每次压缩 / 交接 / 续接各几条），
 *      整份重写的量完全可以接受，而“文件里永远等于内存里”是可验证的。
 *   ③ **脱敏在 shared 层做**（`normalizeHandoffEvent`），这一层只负责落盘，
 *      不给自己留一个「绕过清洗」的入口。
 *
 * ⚠️ 事件里的 detail 已经过 `redactDiagnosticText`：这里**不需要**再清洗一次，
 *    但也**不能**新增「原样写 detail」的调用点。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  HANDOFF_EVENT_LIMIT,
  normalizeHandoffEvent,
  sanitizeHandoffEventLine,
  type HandoffEvent
} from '../shared/handoff-diagnostics'

/** 诊断事件目录（`<YAN_DIR>/handoff/`）。 */
export const HANDOFF_DIAGNOSTICS_DIR = 'handoff'
export const HANDOFF_EVENT_FILE = 'events.jsonl'

export function handoffEventPath(root: string = YAN_DIR): string {
  return join(root, HANDOFF_DIAGNOSTICS_DIR, HANDOFF_EVENT_FILE)
}

export interface HandoffDiagnosticsOptions {
  root?: string
  now?: () => number
  /** 内存保留条数（缺省 `HANDOFF_EVENT_LIMIT`）。 */
  limit?: number
}

/**
 * 诊断日志。
 *
 * `record()` **同步**入内存、异步落盘：调用点几乎全在异步链路里，
 * 但没有一个愿意为了写一行诊断而 await。（也因此提供了 `flush()` 给测试与退出前用。）
 */
export class HandoffDiagnostics {
  private readonly root: string
  private readonly now: () => number
  private readonly limit: number
  private readonly file: string
  private events: HandoffEvent[] = []
  private tail: Promise<void> = Promise.resolve()
  private dirty = false
  private loaded = false

  constructor(options: HandoffDiagnosticsOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.limit = Number.isFinite(options.limit) && (options.limit as number) > 0 ? Math.floor(options.limit as number) : HANDOFF_EVENT_LIMIT
    this.file = handoffEventPath(this.root)
  }

  path(): string {
    return this.file
  }

  /** 读回磁盘尾部（幂等）。坏行跳过，不因为一行脏数据丢掉整个诊断历史。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw = ''
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      /* 还没写过：空历史 */
      return
    }
    const parsed: HandoffEvent[] = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = sanitizeHandoffEventLine(JSON.parse(trimmed))
        if (event) parsed.push(event)
      } catch {
        /* 半行 / 坏 JSON：跳过 */
      }
    }
    this.events = parsed.slice(-this.limit)
  }

  /**
   * 记一条事件。
   *
   * 返回规范化后的事件（调用方可直接用返回值断言，不必再读 `recent()`）。
   */
  record(input: Partial<HandoffEvent> & { at?: number; stage: HandoffEvent['stage']; outcome: string }): HandoffEvent {
    const event = normalizeHandoffEvent({ ...input, at: input.at ?? this.now() })
    this.events.push(event)
    if (this.events.length > this.limit) this.events = this.events.slice(-this.limit)
    this.schedule()
    return event
  }

  /** 最近 n 条（默认全部，新→旧？不：返回**由旧到新**，与文件顺序一致）。 */
  recent(limit = this.limit): HandoffEvent[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : this.limit
    return this.events.slice(-n)
  }

  /** 等落盘队列排空（测试与退出前用）。 */
  async flush(): Promise<void> {
    await this.tail.catch(() => undefined)
  }

  /**
   * 排一次落盘。
   *
   * 同一批（同步连续 record）只写一次：`dirty` 在前一个任务**开始时**清掉，
   * 于是 persist 期间又来的事件会再排一个任务，而不会丢。
   */
  private schedule(): void {
    if (this.dirty) return
    this.dirty = true
    this.tail = this.tail
      .then(async () => {
        this.dirty = false
        await this.persist()
      })
      .catch(() => undefined)
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      const body = this.events.map((event) => JSON.stringify(event)).join('\n')
      await writeFile(temp, body ? `${body}\n` : '', 'utf8')
      await rename(temp, this.file)
    } catch {
      /* 诊断落盘失败不影响任何业务链路 */
    }
  }
}
