/**
 * 页签弹出窗的几何计算（纯函数，v3 · WP-30 弹出）。
 *
 * 不 import Electron：只接收普通矩形，便于在 node 里直接覆盖边界
 * （见 scripts/test-v3-pane-popout.mjs）。复用 aux 的 `clampToArea`，
 * 落点策略是「优先贴主窗口右侧，放不下就放左侧并整体裁回工作区」。
 */
import { clampToArea, type Rect, type Size } from './geometry'

/** 弹出窗默认尺寸：够放一份只读投影列表，又不太靠近桌面宽窗。 */
export const PANE_POPOUT_SIZE: Size = { width: 460, height: 620 }
/** 与主窗口 / 工作区之间的边距。 */
export const PANE_POPOUT_MARGIN = 12
/** 多个弹窗时的纵向错位，避免完全重叠。 */
export const PANE_POPOUT_STAGGER = 28

/**
 * 计算弹出窗落点。
 *
 * 有主窗口时：先尝试贴主窗口右缘（留 margin）；右侧放不下改贴左缘；再整体
 * 裁回工作区。没有主窗口（或已销毁）时退回工作区左上角。`index` 用于同屏
 * 多个弹窗的轻微纵向错位。
 */
export function computePanePopoutBounds(input: {
  anchor?: Rect
  area: Rect
  size?: Size
  margin?: number
  index?: number
}): Rect {
  const size = input.size ?? PANE_POPOUT_SIZE
  const margin = input.margin ?? PANE_POPOUT_MARGIN
  const anchor = input.anchor
  const area = input.area
  if (!anchor) {
    return clampToArea({ x: area.x + margin, y: area.y + margin, width: size.width, height: size.height }, area)
  }
  const rightX = anchor.x + anchor.width + margin
  const leftX = anchor.x - size.width - margin
  const fitsRight = rightX + size.width <= area.x + area.width
  const x = fitsRight ? rightX : leftX
  const y = anchor.y + (input.index ?? 0) * PANE_POPOUT_STAGGER
  return clampToArea({ x, y, width: size.width, height: size.height }, area)
}
