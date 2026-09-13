import type { WebContents } from 'electron'
import { CDP_DOMAINS, type CdpChannel } from './CdpChannel'

/**
 * Electron 每个 WebContents 自带 CDP 调试器；这里封一层带类型的收口：
 * 按需 attach、首次打开常用域、暴露 send/screenshot/detach。
 * 不直接对 `contents.debugger` 裸调，方便以后换成别的通道
 * （外部 Chrome 用 RawCdp，两者实现同一个 CdpChannel）。
 */
export class CDPBridge implements CdpChannel {
  private attached = false

  constructor(private readonly contents: WebContents) {}

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

  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.attachIfNeeded()
    return this.contents.debugger.sendCommand(method, params) as Promise<T>
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
