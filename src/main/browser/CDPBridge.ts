import type { WebContents } from 'electron'
import { CDP_DOMAINS, type CdpChannel } from './CdpChannel'

export const SCREENSHOT_TIMEOUT_MS = 10_000

export class ScreenshotTimeoutError extends Error {
  readonly code = 'SCREENSHOT_TIMEOUT'

  constructor(timeoutMs: number, detail?: string) {
    super(
      `截图 ${Math.round(timeoutMs / 1000)} 秒没有返回：浏览器面板没显示（原生网页隐藏时不产出画面）。可以展开右侧浏览器面板后重试。${detail ? `（${detail}）` : ''}`
    )
    this.name = 'ScreenshotTimeoutError'
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(onTimeout())
    }, timeoutMs)
    work.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

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

  async screenshot(timeoutMs = SCREENSHOT_TIMEOUT_MS): Promise<Buffer> {
    const painted = await this.capturePainted(timeoutMs)
    if (painted instanceof Buffer) return painted
    const result = await withTimeout(
      this.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true
      }),
      timeoutMs,
      () => new ScreenshotTimeoutError(timeoutMs, typeof painted === "string" ? painted : undefined)
    )
    return Buffer.from(result.data, 'base64')
  }

  private async capturePainted(timeoutMs: number): Promise<Buffer | string> {
    if (typeof this.contents.capturePage !== 'function') return 'capturePage 不可用'
    try {
      const image = await withTimeout(this.contents.capturePage(), timeoutMs, () => new Error(`capturePage ${timeoutMs}ms 未返回`))
      return image.isEmpty() ? 'capturePage 得到空图' : image.toPNG()
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
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
