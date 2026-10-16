/**
 * 原生层的遮挡协调（边界 hook 用）。
 *
 * `WebContentsView` 永远盖在 DOM 之上，CSS 的 z-index 压不住它。命令面板
 * （Ctrl+K）、设置、右键菜单、下拉这些浮层打开时必须把原生网页藏起来，关闭
 * 后再归还。真正「藏 / 归还」由 store 既有的 `acquireOverlayBlocker` →
 * `shouldShowBrowser` 协调器负责；这里只做**检测**并在有浮层时领取一个
 * blocker token，不复制可见性状态机、不碰焦点。
 */

/**
 * 会盖住原生层的浮层选择器。
 *
 * 覆盖 v3 的 ModalOverlay / Dialog / Popover / Menu / ListBox（RAC 打开时挂载
 * 或带上 `data-open`）。刻意只认这些「确实浮在界面上」的节点，不把普通的
 * `role="listbox"` 之类一律算上。
 */
export const BLOCKING_OVERLAY_SELECTOR = [
  '.ui-modal-overlay',
  '.ui-popover[data-open]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]'
].join(', ')

/**
 * 用注入的 `query` 判定有没有遮挡浮层 —— 便于在不带 DOM 的环境里单测。
 * 真实调用点传 `(selector) => document.querySelector(selector) !== null`。
 */
export function hasBlockingOverlay(query: (selector: string) => boolean): boolean {
  return query(BLOCKING_OVERLAY_SELECTOR)
}
