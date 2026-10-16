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
