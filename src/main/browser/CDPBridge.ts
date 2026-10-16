import type { WebContents } from 'electron'
import { CDP_DOMAINS, type CdpChannel } from './CdpChannel'

export class CDPBridge implements CdpChannel {
  private attached = false
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>()

  constructor(private readonly contents: WebContents) {
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      for (const cb of this.listeners.get(method) ?? []) cb(params ?? {}, sessionId)
    })
  }

  on(method: string, cb: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(cb)
    return () => set?.delete(cb)
  }

  async attach(): Promise<void> {
    if (this.attached) return
    if (this.contents.debugger.isAttached()) {
      this.attached = true
      return
    }
    this.contents.debugger.attach('1.3')
    this.attached = true
    await Promise.all(CDP_DOMAINS.map((method) => this.send(method)))
  }

  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    await this.attachIfNeeded()
    return this.contents.debugger.sendCommand(method, params, sessionId) as Promise<T>
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    return Buffer.from(result.data, 'base64')
  }

  async detach(): Promise<void> {
    if (!this.attached) return
    this.attached = false
    if (this.contents.debugger.isAttached()) this.contents.debugger.detach()
  }

  private async attachIfNeeded(): Promise<void> {
    if (!this.attached) await this.attach()
  }
}
