/**
 * 运行历史（v3 WP-10）。
 *
 * 每次运行结束向 `YAN_DIR/runs/YYYY-MM-DD.jsonl` 追加一行：运行快照 + 状态时间段。
 * 它只是**索引**：会话内容仍以 pi JSONL 为准，运行总览、运行时间线与用量统计读这里。
 *
 * ── 写入约定 ──
 *   · 追加写 + `fsync`，串行排队（同一注册表内不会有两行交错）。
 *   · 默认用真实文件；测试与上层可注入 `write` 或自定义 `RunHistoryWriter`，
 *     普通单测不碰用户数据目录。
 *   · 写失败如实抛出，由 registry 经 `onError` 报告 —— 不把失败当成已写入。
 */
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { RunCounts, RunKind, RunModel } from '../../shared/runs'

export interface RunHistorySegment {
  phase: string
  from: number
  to: number
}

export interface RunHistoryRecord {
  runId: string
  code: string
  kind: RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  parentRunId?: string
  title: string
  model?: RunModel
  startedAt: number
  endedAt: number
  terminal: 'done' | 'stopped' | 'failed'
  cause?: string
  errorKind?: string
  message?: string
  segments: RunHistorySegment[]
  costUsd?: number
  counts: RunCounts
}

export interface RunHistoryWriter {
  append(record: RunHistoryRecord): Promise<void>
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 运行历史文件按本地日期分片。 */
export function runHistoryPath(at: number, root: string = YAN_DIR): string {
  const date = new Date(at)
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return join(root, 'runs', `${day}.jsonl`)
}

export interface DurableRunHistoryOptions {
  /** 注入写入实现（例如测试写内存）；缺省追加写 JSONL 并 fsync */
  write?: (path: string, text: string, mode: 'append') => Promise<void>
}

/** 默认实现：按天分片追加，串行写，失败抛出。 */
export class DurableRunHistory implements RunHistoryWriter {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string = YAN_DIR,
    private readonly options: DurableRunHistoryOptions = {}
  ) {}

  append(record: RunHistoryRecord): Promise<void> {
    const job = this.tail.then(() => this.write(record))
    this.tail = job.catch(() => undefined)
    return job
  }

  /** 等待所有已排队的写入结束（进程退出 / 测试收尾用）。 */
  whenIdle(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  private async write(record: RunHistoryRecord): Promise<void> {
    const path = runHistoryPath(record.endedAt, this.root)
    const text = `${JSON.stringify(record)}\n`
    if (this.options.write) {
      await this.options.write(path, text, 'append')
      return
    }
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/** 测试用的内存写入器：记录收到的行，不碰磁盘。 */
export class MemoryRunHistory implements RunHistoryWriter {
  readonly records: RunHistoryRecord[] = []
  async append(record: RunHistoryRecord): Promise<void> {
    this.records.push(record)
  }
}
