import type { BrowserWindow } from 'electron'
import { firstDeepLinkArg, parseDeepLink, type DeepLink } from './protocol'

export const DEEPLINK_CHANNEL = 'yan:deeplink'

export interface DeepLinkTarget {
  send: (link: DeepLink) => boolean
  focus: () => void
  whenReady?: (retry: () => void) => boolean
}

export interface DeepLinkRouter {
  handleArgv(argv: readonly string[]): boolean
  handleOpenUrl(url: string): boolean
  flush(): boolean
  pending(): DeepLink | null
}

export function createDeepLinkRouter(target: DeepLinkTarget): DeepLinkRouter {
  let pending: DeepLink | null = null
  let waitingForReady = false

  const attempt = (): boolean => {
    if (!pending) return false
    const link = pending
    if (!target.send(link)) {
      deferFlush()
      return false
    }
    pending = null
    waitingForReady = false
    target.focus()
    return true
  }

  function deferFlush(): void {
    if (waitingForReady || !target.whenReady) return
    waitingForReady = target.whenReady(() => {
      waitingForReady = false
      attempt()
    })
  }

  const deliver = (link: DeepLink): boolean => {
    pending = link
    return attempt()
  }

  return {
    handleArgv(argv) {
      const arg = firstDeepLinkArg(argv)
      if (arg === null) return false
      const parsed = parseDeepLink(arg)
      if (!parsed.ok) return false
      return deliver(parsed.link)
    },
    handleOpenUrl(url) {
      const parsed = parseDeepLink(url)
      if (!parsed.ok) return false
      return deliver(parsed.link)
    },
    flush: attempt,
    pending: () => pending
  }
}

export function windowDeepLinkRouter(getWindow: () => BrowserWindow | undefined, focus: () => void): DeepLinkRouter {
  return createDeepLinkRouter({
    send: (link) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      if (win.webContents.isLoading()) return false
      win.webContents.send(DEEPLINK_CHANNEL, link)
      return true
    },
    focus,
    whenReady: (retry) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      const contents = win.webContents
      const check = (): void => {
        if (win.isDestroyed()) return
        if (contents.isLoading()) {
          contents.once('did-stop-loading', check)
          return
        }
        retry()
      }
      contents.once('did-stop-loading', check)
      return true
    }
  })
}
