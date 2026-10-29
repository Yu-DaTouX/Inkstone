import { BrowserWindow, session } from 'electron'
import { shouldBlockHiddenPageRequest } from '../browser/network-boundary'
import { resolvesToPrivateAddress } from '../browser/network-policy'

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const done = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
}

export class HiddenPageTimeout extends Error {
  constructor(ms: number) {
    super(`超过 ${ms}ms 没有返回`)
  }
}

export class HiddenPageCancelled extends Error {
  constructor() {
    super('已取消')
  }
}

const HIDDEN_PARTITION = 'yan-hidden-search'
let openHiddenPages = 0

export async function withHiddenPage<T>(
  timeoutMs: number,
  fn: (win: BrowserWindow, signal: AbortSignal) => Promise<T>,
  external?: AbortSignal
): Promise<T> {
  external?.throwIfAborted()
  const controller = new AbortController()
  let rejectCancelled: (reason: Error) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  const cancel = (): void => {
    controller.abort()
    rejectCancelled(new HiddenPageCancelled())
  }
  if (external?.aborted) cancel()
  else external?.addEventListener('abort', cancel, { once: true })
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: HIDDEN_PARTITION, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const privateDns = new Map<string, { privateTarget: boolean; expiresAt: number }>()
  const request = session.fromPartition(HIDDEN_PARTITION).webRequest
  openHiddenPages += 1
  request.onBeforeRequest((details, callback) => {
    void shouldBlockHiddenPageRequest(details.url, async (hostname) => {
      const key = hostname.toLowerCase()
      const cached = privateDns.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.privateTarget
      const privateTarget = await resolvesToPrivateAddress(key)
      privateDns.set(key, { privateTarget, expiresAt: Date.now() + 2000 })
      return privateTarget
    })
      .then((block) => callback({ cancel: block }))
      .catch(() => callback({ cancel: true }))
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new HiddenPageTimeout(timeoutMs))
      }, timeoutMs)
    })
    return await Promise.race([fn(win, controller.signal), timeout, cancelled])
  } finally {
    if (timer) clearTimeout(timer)
    external?.removeEventListener('abort', cancel)
    controller.abort()
    if (!win.isDestroyed()) win.destroy()
    openHiddenPages = Math.max(0, openHiddenPages - 1)
    if (openHiddenPages === 0) request.onBeforeRequest(null)
  }
}
