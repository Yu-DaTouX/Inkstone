/**
 * 原生网页视图的显隐协调（实施-11 H-9a）。
 *
 * `WebContentsView` 是原生层，CSS 的 z-index 压不住它。过去各处浮层各写各的
 * `browser.setVisible(true/false)`，谁后关闭谁就把网页提前露出来，或者互相覆盖。
 * 这里收成**一个判定 + 一个 blocker 集合**：
 *
 *   · 只有「浏览器打开 + 当前会话 + 右栏展开 + 活动页就是浏览器 + 没有浮层」
 *     四个条件同时成立，原生网页才可见；
 *   · 每个浮层只领自己的 token，关闭只释放自己的，不会顺带恢复别人的状态；
 *   · 判定是纯函数，调用方只改输入，显隐由协调器统一 apply。
 *
 * 纯函数与计数器都不碰 Electron，便于单测。
 */

export interface BrowserVisibilityInput {
  /** 主进程里有没有打开的原生网页 */
  browserOpen: boolean
  /** 右栏是否展开（收起整个工作栏时原生区域也要一起不可见） */
  rightPanelOpen: boolean
  /** 当前活动页是否就是浏览器 */
  activeBrowserSurface: boolean
  /** 正在占用的 overlay 浮层数量 */
  overlayBlockers: number
}

export function shouldShowBrowser(input: BrowserVisibilityInput): boolean {
  return input.browserOpen && input.rightPanelOpen && input.activeBrowserSurface && input.overlayBlockers === 0
}

/**
 * overlay blocker 计数器。
 *
 * 用「token → 计数」而不是 Set：同一个 token 被嵌套领取（例如两次 openSettings）
 * 时，只有全部释放才真正解除，避免提前恢复原生网页。
 */
export class OverlayBlockers {
  private readonly counts = new Map<string, number>()

  acquire(token: string): void {
    this.counts.set(token, (this.counts.get(token) ?? 0) + 1)
  }

  release(token: string): void {
    const current = this.counts.get(token)
    if (current === undefined) return
    if (current <= 1) this.counts.delete(token)
    else this.counts.set(token, current - 1)
  }

  has(token: string): boolean {
    return this.counts.has(token)
  }

  get size(): number {
    return this.counts.size
  }

  clear(): void {
    this.counts.clear()
  }
}
