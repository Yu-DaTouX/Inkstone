/**
 * 原生浏览器的归属与显隐判定（纯函数，可单测）。
 *
 * 边界：原生 `WebContentsView` 是**单个**主进程资源。渲染端谁也不能自己
 * `setVisible`，否则又回到「谁后关闭谁把网页提前露出来」的老问题。这里只
 * 产生「这块面板有没有资格控制浏览器」这个布尔值，交给 store 既有的
 * `setBrowserSurfaceActive` 与 `shouldShowBrowser` 协调（`state/browser-visibility`）。
 */
import { shouldShowBrowser } from '../../state/browser-visibility'
import type { WorkspaceOwner } from '../workbench/types'

export interface BrowserSurfaceInputs {
  owner: WorkspaceOwner
  /** R0 面板传下来的「这块磁贴/页签现在露在外面吗」。默认 true。 */
  visible: boolean
  /** 主进程里有没有打开的原生网页。 */
  browserOpen: boolean
  /** `resourceOwner('browser')`：浏览器资源当前记在哪个工作区键下（没有则 undefined）。 */
  browserOwnerKey: string | undefined
}

/**
 * 这块面板能否控制（导航 / 标签 / 坐标 / 可见性）原生浏览器。
 *
 * 四个条件同时成立才行：
 *   · `owner.active`——用户正在看这一块；`key` 不是授权。
 *   · `visible`——磁贴/页签当前露在外面。
 *   · `browserOpen`——主进程里确实有网页，不然控制空对象没有意义。
 *   · 资源归属一致——浏览器没有被另一条会话占着；`active=false`
 *     的会话绝不能借当前别的会话的浏览器。
 */
export function browserControlAllowed(inputs: BrowserSurfaceInputs): boolean {
  return (
    inputs.owner.active &&
    inputs.visible &&
    inputs.browserOpen &&
    inputs.browserOwnerKey === inputs.owner.key
  )
}

/**
 * 原生层最终是否该可见：把「有没有资格控制」交给既有的显隐协调器，
 * 再叠加 overlay blocker。这里不自己定义第二套可见性状态机。
 */
export function browserNativeVisible(inputs: BrowserSurfaceInputs, overlayBlocked: boolean): boolean {
  return shouldShowBrowser({
    browserOpen: inputs.browserOpen,
    rightPanelOpen: true,
    activeBrowserSurface: browserControlAllowed(inputs),
    overlayBlockers: overlayBlocked ? 1 : 0
  })
}

/**
 * 「当前原生浏览器表面」的认领令牌。
 *
 * store 的 `setBrowserSurfaceActive` 是裸布尔值；分屏时每列都挂着一个
 * BrowserPane，没有 `active` 的那一列挂载时会调 `false`，把有 `active` 那列
 * 刚设的 `true` 盖掉。令牌保证只有**真正认领过的 key** 能清除，与
 * `OverlayBlockers` 同一思路。
 */
export class BrowserSurfaceClaim {
  private key: string | null = null

  /** 认领成功返回 true；已被别的 key 拿着则不覆盖，返回 false。 */
  claim(key: string): boolean {
    if (this.key === null || this.key === key) {
      this.key = key
      return true
    }
    return false
  }

  /** 只有持有者能释放；不是持有者返回 false（不误清别人的）。 */
  release(key: string): boolean {
    if (this.key !== key) return false
    this.key = null
    return true
  }

  current(): string | null {
    return this.key
  }
}
