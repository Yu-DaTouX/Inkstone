import { JSONRPCMessageSchema } from '@modelcontextprotocol/core'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { BridgeRateLimiter } from './model'

export interface McpAppMessageEvent {
  readonly data: unknown
  readonly origin: string
  readonly source: unknown
}

export interface McpAppWindowLike {
  addEventListener(type: 'message', listener: (event: McpAppMessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: McpAppMessageEvent) => void): void
}

export interface McpAppFrameWindowLike {
  postMessage(message: unknown, targetOrigin: string): void
}

export class McpAppTransport implements Transport {
  onmessage?: Transport['onmessage']
  onclose?: Transport['onclose']
  onerror?: Transport['onerror']
  private closed = false
  private started = false
  private readonly queue: JSONRPCMessage[] = []
  private readonly seen = new Set<string>()
  private readonly limiter = new BridgeRateLimiter()
  private readonly frame: McpAppFrameWindowLike | null
  private readonly listener = (event: McpAppMessageEvent): void => {
    if (this.closed) return
    if (event.origin !== 'null') return this.reject('origin', null)
    if (!this.frame || event.source !== this.frame) return this.reject('source', null)
    if (!this.limiter.allow(Date.now())) return this.reject('limit', null)
    try {
      if (new TextEncoder().encode(JSON.stringify(event.data)).byteLength > 1024 * 1024) return this.reject('size', null)
    } catch { return this.reject('shape', null) }
    const parsed = JSONRPCMessageSchema.safeParse(event.data)
    if (!parsed.success) return this.reject('shape', null)
    const message = parsed.data
    if ('id' in message && typeof message.id === 'string' && message.id.length > 128) return this.reject('size', null)
    if ('method' in message && message.method.length > 128) return this.reject('shape', null)
    if ('method' in message && 'id' in message) {
      const key = `${typeof message.id}:${message.id}`
      if (this.seen.has(key)) return this.reject('duplicate', message.method)
      if (this.seen.size >= 512) return this.reject('limit', message.method)
      this.seen.add(key)
    }
    if (this.started) this.onmessage?.(message)
    else if (this.queue.length < 16) this.queue.push(message)
    else this.reject('limit', null)
  }

  constructor(
    private readonly window: McpAppWindowLike,
    getFrame: () => McpAppFrameWindowLike | null,
    private readonly reject: (reason: string, method: string | null) => void
  ) {
    this.frame = getFrame()
    window.addEventListener('message', this.listener)
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('App transport closed')
    this.started = true
    for (const message of this.queue.splice(0)) this.onmessage?.(message)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('App transport closed')
    this.frame?.postMessage(message, '*')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.window.removeEventListener('message', this.listener)
    this.queue.length = 0
    this.seen.clear()
    this.onclose?.()
  }
}
