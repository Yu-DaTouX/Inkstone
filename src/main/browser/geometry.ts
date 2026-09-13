import type { CdpChannel } from './CdpChannel'

/** [x, y, width, height]，单位是**相对视口**的 CSS 像素。 */
export type Box = [number, number, number, number]

/**
 * 取元素相对视口的包围盒。
 *
 * 为什么单独抽出来：`DOM.getBoxModel` 返回的坐标已经扣掉了滚动偏移
 * （页面往下滚之后，视口上方的元素 y 为负），与 `Input.dispatch*`
 * 需要的坐标系一致。但**前提是测量必须发生在滚动之后** ——
 * `browser_observe` 拿到的盒子会随着 `scrollIntoViewIfNeeded` 立刻过期，
 * 所以点击/输入要在这里重新量一次，不能复用观察时的坐标。
 */
export async function elementBox(cdp: CdpChannel, backendNodeId: number): Promise<Box | null> {
  const result = await cdp
    .send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId })
    .catch(() => null)
  const points = result?.model?.content ?? []
  if (points.length < 8) return null
  const xs = [points[0], points[2], points[4], points[6]]
  const ys = [points[1], points[3], points[5], points[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y]
}

export function centerOf(box: Box): { x: number; y: number } {
  return { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 }
}
