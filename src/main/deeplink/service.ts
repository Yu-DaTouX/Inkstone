/**
 * 深链接转发器：把已校验的导航意图投递给渲染端。
 *
 * 与 `protocol.ts` 分开的原因：解析是纯逻辑（可单测），投递依赖 Electron
 * 窗口。主进程入口拿到 `second-instance` / `open-url` / 启动 argv 后只调
 * `handleArgv` / `handleOpenUrl` / `flush`，不自己判断 URL。
 *
 * 深链接**只导航**：这里只 `send`，不调用任何会产生副作用的宿主能力。
 *
 * 早于窗口就绪到达的链接（macOS `open-url` 可能在 `ready` 前触发）先入一行
 * 待发缓冲，窗口可用后由入口调用 `flush()` 补投；缓冲只保留最后一条，避免
 * 用户连点时排队执行一串过期导航。
 */
import type { BrowserWindow } from 'electron'
import { firstDeepLinkArg, parseDeepLink, type DeepLink } from './protocol'

/** 主进程 → 渲染端的深链接推送通道；preload 用同一字面量订阅。 */
export const DEEPLINK_CHANNEL = 'yan:deeplink'

export interface DeepLinkTarget {
  /** 投递一条意图；窗口还没就绪时返回 false（此时不聚焦）。 */
  send: (link: DeepLink) => boolean
  /** 把主窗口显示并聚焦。 */
  focus: () => void
}

export interface DeepLinkRouter {
  /** 处理 `second-instance` / 启动 argv：有 `inkstone:` 参数就投递，返回 true。 */
  handleArgv(argv: readonly string[]): boolean
  /** 处理 macOS `open-url`：合法就投递，返回 true。 */
  handleOpenUrl(url: string): boolean
  /** 补投此前因窗口未就绪而缓存的链接；没有缓存返回 false。 */
  flush(): boolean
  /** 待发链接（测试与日志用）。 */
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
    /* 窗口未就绪：只留最后一条，等 flush()。 */
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

/**
 * 用真实主窗口构造转发器。
 *
 * `getWindow` 允许窗口尚未创建 / 已销毁；`focus` 由入口传入
 * `showMainWindow`，与 `second-instance` 的既有行为一致。
 */
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
