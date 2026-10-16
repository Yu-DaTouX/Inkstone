import { randomUUID } from 'node:crypto'
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

export async function withHiddenPage<T>(
  timeoutMs: number,
  fn: (win: BrowserWindow, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const partition = `yan-hidden-${randomUUID()}`
  const controller = new AbortController()
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const privateDns = new Map<string, { privateTarget: boolean; expiresAt: number }>()
  session.fromPartition(partition).webRequest.onBeforeRequest((details, callback) => {
    void shouldBlockHiddenPageRequest(details.url, async (hostname) => {
      const key = hostname.toLowerCase()
      const cached = privateDns.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.privateTarget
      const privateTarget = await resolvesToPrivateAddress(key)
      privateDns.set(key, { privateTarget, expiresAt: Date.now() + 2000 })
      return privateTarget
    })
      .then((block) => callback({ cancel: block }))
      .catch(() => callback({}))
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new HiddenPageTimeout(timeoutMs))
      }, timeoutMs)
    })
    return await Promise.race([fn(win, controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    if (!win.isDestroyed()) win.destroy()
  }
}
