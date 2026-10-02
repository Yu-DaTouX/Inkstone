/**
 * 砚到中继的出站连接：以房主身份连上中继，把中继转来的每个客户端变成一条虚拟连接（Pipe）。
 * 中继协议与礁石一致：主机连 /v1/host?key=…；中继发 {t:"open"|"msg"|"close", c, d}，主机回 {t:"msg"|"kick", c, d}；
 * 文本 "ping"/"pong" 保活。断线指数退避重连（2 秒起，最长 60 秒），75 秒收不到 pong 视为断开。
 */
import type { Pipe } from './tunnel'

const PING_MS = 25_000
const DEAD_MS = 75_000

export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown; code?: number }) => void): void
}
export type WsCtor = new (url: string) => WsLike

/** https → wss，去掉结尾斜杠。 */
export function relayWsBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/^http(s?):\/\//, 'ws$1://')
}

class VirtualPipe implements Pipe {
  onmessage?: (text: string) => void
  onclose?: () => void
  open = true
  constructor(private readonly link: RelayLink, readonly id: number) {}
  send(text: string): void {
    if (this.open) this.link.forward(this.id, text)
  }
  close(): void {
    if (!this.open) return
    this.link.kick(this.id)
    this.ended()
  }
  ended(): void {
    if (!this.open) return
    this.open = false
    this.onclose?.()
  }
}

export interface RelayLinkOptions {
  url: string
  secret: string
  onPipe(pipe: Pipe): void
  onState?(connected: boolean, detail?: string): void
  log?(text: string): void
  WebSocket?: WsCtor
}

export class RelayLink {
  private ws: WsLike | undefined
  private readonly pipes = new Map<number, VirtualPipe>()
  private stopped = true
  private delayMs = 2_000
  private lastPong = 0
  private pinger: ReturnType<typeof setInterval> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  connected = false

  constructor(private readonly opts: RelayLinkOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.teardown()
  }

  forward(id: number, text: string): void {
    this.raw(JSON.stringify({ t: 'msg', c: id, d: text }))
  }

  kick(id: number): void {
    this.pipes.delete(id)
    this.raw(JSON.stringify({ t: 'kick', c: id }))
  }

  private raw(text: string): void {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(text)
    } catch {
      /* 发送失败由 close 事件处理重连 */
    }
  }

  private connect(): void {
    if (this.stopped) return
    const Ctor = this.opts.WebSocket ?? (globalThis.WebSocket as unknown as WsCtor)
    let ws: WsLike
    try {
      ws = new Ctor(`${relayWsBase(this.opts.url)}/v1/host?key=${encodeURIComponent(this.opts.secret)}`)
    } catch (error) {
      this.opts.log?.(`中继连接失败：${error instanceof Error ? error.message : String(error)}`)
      this.schedule()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.connected = true
      this.delayMs = 2_000
      this.lastPong = Date.now()
      this.opts.onState?.(true)
      this.pinger = setInterval(() => {
        if (Date.now() - this.lastPong > DEAD_MS) {
          this.opts.log?.('中继心跳超时，重连')
          this.teardown()
          this.schedule()
          return
        }
        this.raw('ping')
      }, PING_MS)
      this.pinger.unref?.()
    })
    ws.addEventListener('message', (ev) => this.onRelayMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return
      const detail = ev.code === 4001 ? '另一个程序用同一个房间连上了中继，本机被顶替' : `连接断开（${ev.code ?? '?'}）`
      this.opts.onState?.(false, detail)
      this.teardown()
      if (ev.code !== 4001) this.schedule()
    })
    ws.addEventListener('error', () => {
      /* 随后会有 close 事件 */
    })
  }

  private schedule(): void {
    if (this.stopped || this.retry) return
    const wait = this.delayMs
    this.delayMs = Math.min(this.delayMs * 2, 60_000)
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.connect()
    }, wait)
    this.retry.unref?.()
  }

  private teardown(): void {
    const was = this.connected
    this.connected = false
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = undefined
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close()
    } catch {
      /* 已关闭 */
    }
    for (const p of this.pipes.values()) p.ended()
    this.pipes.clear()
    if (was) this.opts.onState?.(false)
  }

  private onRelayMessage(text: string): void {
    if (text === 'pong') {
      this.lastPong = Date.now()
      return
    }
    let msg: { t?: unknown; c?: unknown; d?: unknown }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return
    }
    const id = Number(msg.c)
    if (!Number.isInteger(id)) return
    if (msg.t === 'open') {
      const pipe = new VirtualPipe(this, id)
      this.pipes.set(id, pipe)
      this.opts.onPipe(pipe)
    } else if (msg.t === 'msg' && typeof msg.d === 'string') {
      this.pipes.get(id)?.onmessage?.(msg.d)
    } else if (msg.t === 'close') {
      const pipe = this.pipes.get(id)
      this.pipes.delete(id)
      pipe?.ended()
    }
  }
}
