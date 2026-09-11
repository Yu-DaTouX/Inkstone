/**
 * 记忆存储 —— 砚的核心。
 *
 * 认识论规则（**不要为了"方便"破坏它**）：
 *
 *   · agent 的 `remember` 工具只能创建 kind='guess'（来源：我，未确认）
 *   · 只有**用户在界面上确认**，才变成 kind='fact'（来源：你）
 *   · 注入系统提示词时，fact 直接陈述，guess 必须带「我不确定」的语气
 *
 * 这条规则就是"agent 不能自己批准自己的判断"。它让右栏那个「对/不对」按钮
 * 有实际后果，而不是装饰。
 *
 * 文件位置与扩展共享：~/.pi/agent/yan/memory.json
 * 扩展（resources/pi/yan-memory.ts）直接读写同一个文件，
 * 主进程用 fs.watch 感知外部改动 → 推送 memory-changed。
 * 这样即使 agent 手写文件，界面也会同步。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { MemoryItem, MemoryKind } from '../shared/ipc'

/**
 * 砚的数据目录。
 *
 * `YAN_DATA_DIR` 可覆盖 —— 测试用隔离目录，免得污染用户的真实记忆。
 * 注意：pi 扩展（resources/pi/yan-memory.ts）读同一个环境变量，
 * 所以主进程与扩展会达成一致，不会一边写真实目录一边读隔离目录。
 */
export const YAN_DIR =
  process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')

export const MEMORY_FILE = join(YAN_DIR, 'memory.json')
export const SETTINGS_FILE = join(YAN_DIR, 'desktop.json')

interface MemoryFile {
  version: 1
  items: MemoryItem[]
}

const EMPTY: MemoryFile = { version: 1, items: [] }

function newId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export class MemoryStore {
  private items: MemoryItem[] = []
  private watcher: FSWatcher | null = null
  private onExternalChange: ((items: MemoryItem[]) => void) | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private selfWriteUntil = 0

  async load(): Promise<MemoryItem[]> {
    // 先把挂起的写入落盘，否则刚改完立刻读会读到旧文件，
    // 把内存里的改动“回滍”掉（删掉的条目会复活）。
    await this.writeQueue

    try {
      const raw = await readFile(MEMORY_FILE, 'utf8')
      const parsed = JSON.parse(raw) as MemoryFile
      this.items = Array.isArray(parsed.items) ? parsed.items.filter(isValid) : []
    } catch {
      // 文件不存在 / 坏掉 → 空记忆，不报错。记忆没了不该让应用起不来。
      this.items = []
    }
    return this.list()
  }

  list(): MemoryItem[] {
    // 未确认的排前面（它们需要用户处理），然后按更新时间倒序
    return [...this.items].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'guess' ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  /** 只返回已确认的 —— 注入系统提示词用 */
  confirmed(): MemoryItem[] {
    return this.items.filter((m) => m.kind === 'fact')
  }

  unconfirmed(): MemoryItem[] {
    return this.items.filter((m) => m.kind === 'guess')
  }

  add(input: { text: string; kind: MemoryKind; source?: 'you' | 'me'; topic?: string; sessionId?: string }): MemoryItem[] {
    const text = input.text.trim()
    if (!text) return this.list()

    // 去重：同一 topic 下文本相同就不重复加
    const dup = this.items.find((m) => m.text === text && m.topic === (input.topic ?? 'about'))
    if (dup) return this.list()

    const now = Date.now()
    const item: MemoryItem = {
      id: newId(),
      kind: input.kind,
      text,
      // 认识论：fact 必然来自用户；agent 只能产出 guess
      source: input.kind === 'fact' ? 'you' : (input.source ?? 'me'),
      topic: input.topic ?? 'about',
      createdAt: now,
      updatedAt: now,
      confirmedAt: input.kind === 'fact' ? now : undefined,
      sessionId: input.sessionId
    }

    this.items.push(item)
    void this.persist()
    return this.list()
  }

  update(id: string, patch: Partial<Pick<MemoryItem, 'text' | 'topic' | 'kind'>>): MemoryItem[] {
    const it = this.items.find((m) => m.id === id)
    if (!it) return this.list()

    if (patch.text !== undefined) it.text = patch.text.trim() || it.text
    if (patch.topic !== undefined) it.topic = patch.topic
    if (patch.kind !== undefined && patch.kind !== it.kind) {
      it.kind = patch.kind
      it.source = patch.kind === 'fact' ? 'you' : 'me'
      it.confirmedAt = patch.kind === 'fact' ? Date.now() : undefined
    }
    it.updatedAt = Date.now()
    void this.persist()
    return this.list()
  }

  /**
   * 用户确认/否认。这是唯一能让 guess → fact 的入口。
   * ok=false 表示"不对" —— 直接删掉，不留残渣。
   */
  confirm(id: string, ok: boolean): MemoryItem[] {
    if (!ok) return this.remove(id)
    return this.update(id, { kind: 'fact' })
  }

  remove(id: string): MemoryItem[] {
    this.items = this.items.filter((m) => m.id !== id)
    void this.persist()
    return this.list()
  }

  clear(): MemoryItem[] {
    this.items = []
    void this.persist()
    return this.list()
  }

  /** 供扩展使用：按 id 取一条 */
  get(id: string): MemoryItem | undefined {
    return this.items.find((m) => m.id === id)
  }

  /* ---------------------------------------------------------------- 文件 */

  /** 原子写：先写 .tmp 再 rename，避免读到半个文件 */
  private async persist(): Promise<void> {
    this.selfWriteUntil = Date.now() + 500
    const payload: MemoryFile = { version: 1, items: this.items }
    const data = JSON.stringify(payload, null, 2)

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(MEMORY_FILE), { recursive: true })
        const tmp = `${MEMORY_FILE}.tmp`
        await writeFile(tmp, data, 'utf8')
        await rename(tmp, MEMORY_FILE)
      } catch (e) {
        console.error('[memory] 写入失败：', e)
      }
    })
    return this.writeQueue
  }

  /**
   * 监听外部（扩展）写入。
   * 注意：fs.watch 在 Windows 上可能重复触发，用 selfWrite 时间窗 + 去抖挡掉。
   */
  watch(onChange: (items: MemoryItem[]) => void): void {
    this.onExternalChange = onChange
    if (this.watcher) return
    if (!existsSync(YAN_DIR)) return // 目录还没有，等第一次写入后 ensureWatch 再挂

    try {
      // 用 node:fs 的 watch（返回 FSWatcher），不是 fs/promises 那个异步迭代器
      const w = watch(YAN_DIR, { persistent: false }, (_ev, filename) => {
        if (filename && !String(filename).includes('memory.json')) return
        if (Date.now() < this.selfWriteUntil) return // 自己写的，忽略

        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          const before = JSON.stringify(this.items)
          void this.load().then((next) => {
            if (JSON.stringify(next) !== before) this.onExternalChange?.(next)
          })
        }, 120)
      })

      let timer: ReturnType<typeof setTimeout> | null = null
      w.on('error', () => {
        /* 目录被删之类，忽略 */
      })
      this.watcher = w
    } catch (e) {
      console.error('[memory] 监听失败：', e)
    }
  }

  /** 目录可能一开始不存在，第一次 persist 之后再挂 watcher */
  ensureWatch(): void {
    if (!this.watcher && this.onExternalChange) {
      const cb = this.onExternalChange
      this.onExternalChange = null
      this.watch(cb)
    }
  }

  /**
   * 等所有挂起的写盘完成。
   *
   * 为什么必须有这个：persist() 是链在 writeQueue 上的异步操作，
   * 而窗口关闭 / app.exit() 不会等它 —— 用户点完「对」立刻关窗口，
   * 那次确认就丢了。退出前必须 await 一次。
   */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  close(): void {
    void this.watcher?.close()
    this.watcher = null
  }
}

/**
 * 身份（soul.md）—— 只读。
 *
 * 这个文件是 agent 的自我描述，**故意不给它任何写入路径**：
 * 扩展里没有改文件的工具，UI 上也只有只读展示。
 * 界面上那句「来自 soul.md · 我不会改它」因此是真的，不是文案。
 *
 * 格式极简（`键: 值` 每行一条），解析失败就回退到默认值。
 */
export const SOUL_FILE = join(YAN_DIR, 'soul.md')

const SOUL_DEFAULTS = { name: '砚', selfRef: '我', tone: '直说，不绕，不奉承' }

export async function readSoul(): Promise<{ name: string; selfRef: string; tone: string }> {
  try {
    const raw = await readFile(SOUL_FILE, 'utf8')
    const out = { ...SOUL_DEFAULTS }
    for (const line of raw.split('\n')) {
      const m = /^\s*(名字|name|自称|selfRef|self|语气|tone)\s*[:：]\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      const key = m[1]
      const val = m[2]
      if (key === '名字' || key === 'name') out.name = val
      else if (key === '自称' || key === 'selfRef' || key === 'self') out.selfRef = val
      else if (key === '语气' || key === 'tone') out.tone = val
    }
    return out
  } catch {
    return { ...SOUL_DEFAULTS }
  }
}

/** 宽松校验：宁可丢一条坏数据，也不要让整个面板崩 */
function isValid(x: unknown): x is MemoryItem {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    (o.kind === 'fact' || o.kind === 'guess') &&
    (o.source === 'you' || o.source === 'me') &&
    typeof o.createdAt === 'number'
  )
}
