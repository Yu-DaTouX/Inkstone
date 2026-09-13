/**
 * 原生 WebSocket 版 CDP 通道 —— 用来驱动**外部 Chrome**。
 *
 * 为什么不能复用 Electron 的 `webContents.debugger`：那条通道只对 Electron
 * 自己创建的 WebContents 有效；用户在系统里装的 Chrome 是另一个进程，
 * 只能通过它自己暴露的 DevTools WebSocket 连过去。
 *
 * 为什么自己写而不引入 chrome-remote-interface / puppeteer：这条需求只用到
 * 一小撮 CDP 命令（Page/DOM/Accessibility/Input），而这些命令的调用方式
 * 已经由 `CdpChannel` 固定。引入一个会自己下载 Chromium 的重依赖来跑
 * 「连用户已有 Chrome」，既不必要也把分发包撑大。
 *
 * Node 22（Electron 44 自带）已经有全局 `WebSocket`，不再需要 ws 包。
 */
import { CDP_DOMAINS, type CdpChannel } from './CdpChannel'

/** 只用到 WebSocket 的最小面，避开 DOM lib 与 node 类型对全局 WebSocket 的分歧 */
interface WsLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void
}

function WebSocketCtor(): new (url: string) => WsLike {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket
  if (!ctor) throw new Error('当前 Node 没有全局 WebSocket（需要 Node 22+）')
  return ctor
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT = 20_000

export class RawCdp implements CdpChannel {
  private ws: WsLike | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private attaching: Promise<void> | null = null
  private attached = false
  /** CDP 事件订阅（`method` → 回调集合）。下载等浏览器事件走这条路。 */
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  constructor(private readonly webSocketDebuggerUrl: string) {}

  /**
   * 订阅一个 CDP 事件（无需 id 的那些，如 `Browser.downloadProgress`）。
   * 返回取消订阅函数；连接重建后需要重新订阅。
   */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }

  async attach(): Promise<void> {
    if (this.attached) return
    if (this.attaching) return this.attaching
    this.attaching = (async () => {
      const ws = new (WebSocketCtor())(this.webSocketDebuggerUrl)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            reject(new Error('连接 Chrome DevTools WebSocket 超时'))
          }
        }, REQUEST_TIMEOUT)
        ws.addEventListener('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        })
        ws.addEventListener('error', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error('无法连接 Chrome DevTools WebSocket'))
        })
      })
      ws.addEventListener('message', (ev) => this.onMessage(ev.data))
      // 连接断开时让所有在途请求失败，避免永久挂起
      ws.addEventListener('close', () => this.failAll(new Error('Chrome DevTools 连接已断开')))
      this.ws = ws
      this.attached = true
      for (const method of CDP_DOMAINS) await this.send(method)
    })().finally(() => {
      this.attaching = null
    })
    return this.attaching
  }

  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.attached) await this.attach()
    const ws = this.ws
    if (!ws) throw new Error('Chrome DevTools 未连接')
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令 ${method} 超时`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })
      try {
        ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    return Buffer.from(result.data, 'base64')
  }

  async detach(): Promise<void> {
    const ws = this.ws
    this.attached = false
    this.ws = null
    this.failAll(new Error('Chrome DevTools 通道已关闭'))
    try {
      ws?.close()
    } catch {
      /* 已断开 */
    }
  }

  private onMessage(data: unknown): void {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string }
    }
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as typeof msg
    } catch {
      return
    }
    // 事件（无 id）：分发给订阅者
    if (msg.id === undefined) {
      if (msg.method) {
        const set = this.listeners.get(msg.method)
        if (set) for (const cb of set) cb(msg.params ?? {})
      }
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP 命令失败'))
    else p.resolve(msg.result)
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
}

/* ==================================================================
   调试端口上的 HTTP 目标发现
   ================================================================== */

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/** 一个调试端口上是否已经有 Chrome 在监听 */
export async function cdpReady(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch {
    return false
  }
}

/** 轮询直到 DevTools 端口可用，或超时抛错 */
export async function waitForCdp(port: number, timeoutMs = 15_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cdpReady(port)) return
    if (Date.now() >= deadline) throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs}ms 内未就绪`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 列出可调试目标 */
export async function listTargets(port: number, timeoutMs = 4000): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`列出 Chrome 目标失败：HTTP ${res.status}`)
  const raw = (await res.json()) as unknown
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? ''),
      title: String(t.title ?? ''),
      url: String(t.url ?? ''),
      webSocketDebuggerUrl: typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined
    }))
}

/** 从目标里挑一个可连的 page（普通网页，不是 service_worker / iframe） */
export function pickPageTarget(targets: CdpTarget[]): CdpTarget | undefined {
  return targets.find((t) => t.type === 'page' && !!t.webSocketDebuggerUrl)
}

/** 新建一个标签页并返回它的目标（Chrome 111+ 要求 PUT） */
export async function createTab(port: number, url: string): Promise<CdpTarget | undefined> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(6000)
  })
  if (!res.ok) return undefined
  const t = (await res.json()) as Record<string, unknown>
  return {
    id: String(t.id ?? ''),
    type: String(t.type ?? 'page'),
    title: String(t.title ?? ''),
    url: String(t.url ?? url),
    webSocketDebuggerUrl: typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined
  }
}

/** 让某个目标自己关闭 */
export async function closeTarget(port: number, id: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000)
    })
  } catch {
    /* 浏览器可能已经不在了 */
  }
}
