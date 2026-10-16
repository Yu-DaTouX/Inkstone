/**
 * 辅助小窗的几何计算（v3 WP-25d 快速提问 / WP-12 迷你小窗）。
 *
 * 纯函数：只接收普通矩形，不 import Electron，便于在 node 里直接覆盖边界
 * （见 scripts/test-v3-aux-windows.mjs）。真实的显示器查询与 `setBounds`
 * 调用留在 quick-ask-window.ts / mini-window.ts。
 *
 * 两个窗口都贴着主窗口摆放，而不是屏幕角落：快速提问在主窗口上方居中，
 * 迷你小窗贴主窗口（没有主窗口时贴工作区）的右上角，并且始终裁回工作区，
 * 避免多显示器或主窗口拖到屏幕边缘时小窗跑出可见范围。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** 快速提问小窗：设计规范 §13.3 的 560×160 浮动输入框。 */
export const QUICK_ASK_SIZE: Size = { width: 560, height: 160 }
/** 迷你小窗：设计规范 §13.4 的宽 320；高度按条目自适应，给一个默认。 */
export const MINI_SIZE: Size = { width: 320, height: 264 }
/** 小窗与工作区 / 主窗口之间保留的边距。 */
export const AUX_MARGIN = 12

/** 把矩形整体裁进工作区；工作区比窗口还小时至少贴左上，宽高取工作区尺寸。 */
export function clampToArea(bounds: Rect, area: Rect): Rect {
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), maxY)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

/**
 * 快速提问窗口的摆放。
 *
 * 有主窗口时：水平居中于主窗口，垂直放在主窗口上方约 1/4 处 —— 用户视线
 * 本来就在主窗口，浮窗不要跳到别处。没有主窗口（或主窗口不在任何显示器上）
 * 时退回工作区居中偏上。
 */
export function computeQuickAskBounds(input: {
  anchor?: Rect
  area: Rect
  size?: Size
  /** 相对锚点顶部的比例，0 = 顶部，1 = 底部。 */
  verticalRatio?: number
}): Rect {
  const size = input.size ?? QUICK_ASK_SIZE
  const anchor = input.anchor
  const ratio = input.verticalRatio ?? 0.25
  const centerX = anchor ? anchor.x + (anchor.width - size.width) / 2 : input.area.x + (input.area.width - size.width) / 2
  const topY = anchor ? anchor.y + (anchor.height - size.height) * ratio : input.area.y + (input.area.height - size.height) * ratio
  return clampToArea({ x: centerX, y: topY, width: size.width, height: size.height }, input.area)
}

/**
 * 迷你小窗的摆放：贴主窗口右上角（有主窗口时），否则贴工作区右上角。
 * 默认不可拖动到屏幕外 —— 位置每轮刷新时都重算。
 */
export function computeMiniBounds(input: { area: Rect; anchor?: Rect; size?: Size; margin?: number }): Rect {
  const size = input.size ?? MINI_SIZE
  const margin = input.margin ?? AUX_MARGIN
  const anchor = input.anchor
  const right = anchor ? anchor.x + anchor.width : input.area.x + input.area.width
  const top = anchor ? anchor.y : input.area.y
  return clampToArea(
    { x: right - size.width - margin, y: top + margin, width: size.width, height: size.height },
    input.area
  )
}
