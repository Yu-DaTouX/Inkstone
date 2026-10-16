import type { BrowserWindow } from 'electron'
import { firstDeepLinkArg, parseDeepLink, type DeepLink } from './protocol'

export const DEEPLINK_CHANNEL = 'yan:deeplink'

export interface DeepLinkTarget {
  send: (link: DeepLink) => boolean
  focus: () => void
}

export interface DeepLinkRouter {
  handleArgv(argv: readonly string[]): boolean
  handleOpenUrl(url: string): boolean
  flush(): boolean
  pending(): DeepLink | null
}

export function createDeepLinkRouter(target: DeepLinkTarget): DeepLinkRouter {
  let pending: DeepLink | null = null

  const deliver = (link: DeepLink): boolean => {
    if (target.send(link)) {
      pending = null
      target.focus()
      return true
    }
    pending = link
    return false
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
    flush() {
      if (!pending) return false
      const link = pending
      if (!target.send(link)) return false
      pending = null
      target.focus()
      return true
    },
    pending: () => pending
  }
}

export function windowDeepLinkRouter(getWindow: () => BrowserWindow | undefined, focus: () => void): DeepLinkRouter {
  return createDeepLinkRouter({
    send: (link) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      win.webContents.send(DEEPLINK_CHANNEL, link)
      return true
    },
    focus
  })
}
