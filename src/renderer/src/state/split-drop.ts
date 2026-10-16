import { create } from 'zustand'

interface SplitDropState {
  dragging: boolean
  zone: number | null
  at: number | null
  set(next: { dragging: boolean; zone: number | null; at: number | null }): void
}

export const useSplitDrop = create<SplitDropState>((set) => ({
  dragging: false,
  zone: null,
  at: null,
  set: (next) => set(next)
}))

export interface SplitDropZoneRect {
  at: number
  rect: DOMRect
}

export function splitDropZones(): SplitDropZoneRect[] | null {
  const canvas = document.querySelector('.split-row') ?? document.querySelector('.tile-workspace-canvas')
  if (!canvas) return null
  const base = canvas.getBoundingClientRect()
  if (base.width < 200 || base.height < 120) return null
  const frames = [...canvas.querySelectorAll<HTMLElement>('.tile-frame.primary')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 40 && r.height > 40)
    .sort((a, b) => a.left - b.left)
  const tiles = frames.length ? frames : [base]
  const out: SplitDropZoneRect[] = []
  tiles.forEach((r, i) => {
    const half = r.width / 2
    out.push({ at: i, rect: new DOMRect(r.left, r.top, half, r.height) })
    out.push({ at: i + 1, rect: new DOMRect(r.left + half, r.top, half, r.height) })
  })
  return out
}

export function splitDropHit(x: number, y: number): { zone: number; at: number } | null {
  const zones = splitDropZones()
  if (!zones) return null
  for (let i = 0; i < zones.length; i++) {
    const r = zones[i].rect
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { zone: i, at: zones[i].at }
  }
  return null
}
