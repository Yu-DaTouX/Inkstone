import type { CdpChannel } from './CdpChannel'

export type Box = [number, number, number, number]

export async function elementBox(cdp: CdpChannel, backendNodeId: number, sessionId?: string): Promise<Box | null> {
  const result = await cdp
    .send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId }, sessionId)
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

export interface Viewport {
  width: number
  height: number
}

function quadBox(points: number[]): Box | null {
  if (points.length < 8) return null
  const xs = [points[0], points[2], points[4], points[6]]
  const ys = [points[1], points[3], points[5], points[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y]
}

export async function elementQuads(cdp: CdpChannel, backendNodeId: number, sessionId?: string): Promise<Box[]> {
  const result = await cdp
    .send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId }, sessionId)
    .catch(() => null)
  return (result?.quads ?? []).map(quadBox).filter((box): box is Box => !!box && box[2] > 0 && box[3] > 0)
}

export function visibleBoxes(boxes: readonly Box[], viewport: Viewport | null): Box[] {
  const clipped = boxes.map((box): Box | null => {
    if (!viewport) return box
    const left = Math.max(0, box[0])
    const top = Math.max(0, box[1])
    const right = Math.min(viewport.width, box[0] + box[2])
    const bottom = Math.min(viewport.height, box[1] + box[3])
    return right - left >= 1 && bottom - top >= 1 ? [left, top, right - left, bottom - top] : null
  })
  return clipped.filter((box): box is Box => !!box).sort((a, b) => b[2] * b[3] - a[2] * a[3])
}

export function candidatePoints(boxes: readonly Box[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  for (const box of boxes) {
    points.push(centerOf(box))
    for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.25], [0.75, 0.75]]) {
      points.push({ x: box[0] + box[2] * fx, y: box[1] + box[3] * fy })
    }
  }
  return points
}
