import { create } from 'zustand'

export const DRAG_THRESHOLD = 6

export interface DropRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DropZone {
  at: number
  side: 'left' | 'right'
  rect: DropRect
}

export function dropZonesFor(area: DropRect | null, cols: readonly DropRect[]): DropZone[] {
  const tiles = (cols.length ? cols : area ? [area] : [])
    .filter((r) => r.width >= 160 && r.height >= 120)
    .slice()
    .sort((a, b) => a.left - b.left)
  const out: DropZone[] = []
  tiles.forEach((r, i) => {
    const half = r.width / 2
    out.push({ at: i, side: 'left', rect: { left: r.left, top: r.top, width: half, height: r.height } })
    out.push({ at: i + 1, side: 'right', rect: { left: r.left + half, top: r.top, width: r.width - half, height: r.height } })
  })
  return out
}

export function hitDropZone(zones: readonly DropZone[], x: number, y: number): number {
  for (let i = 0; i < zones.length; i++) {
    const r = zones[i].rect
    if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return i
  }
  return -1
}

export function passedThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return dx * dx + dy * dy >= threshold * threshold
}

const toRect = (r: DOMRect): DropRect => ({ left: r.left, top: r.top, width: r.width, height: r.height })

export function measureDropZones(): DropZone[] {
  if (typeof document === 'undefined') return []
  if (document.querySelector('.v3-root[data-narrow="1"]')) return []
  const chat = document.querySelector<HTMLElement>('.v3-chat')
  if (!chat) return []
  const cols = [...chat.querySelectorAll<HTMLElement>('[data-testid="v3-split-col"]')].map((el) => toRect(el.getBoundingClientRect()))
  return dropZonesFor(toRect(chat.getBoundingClientRect()), cols)
}

export interface SessionDragState {
  item: { id: string; path: string; title: string } | null
  x: number
  y: number
  zones: DropZone[]
  hit: number
  begin(item: { id: string; path: string; title: string }, x: number, y: number): void
  move(x: number, y: number): void
  end(): void
}

export const useSessionDrag = create<SessionDragState>((set, get) => ({
  item: null,
  x: 0,
  y: 0,
  zones: [],
  hit: -1,
  begin: (item, x, y) => {
    const zones = measureDropZones()
    set({ item, x, y, zones, hit: hitDropZone(zones, x, y) })
  },
  move: (x, y) => {
    if (!get().item) return
    set({ x, y, hit: hitDropZone(get().zones, x, y) })
  },
  end: () => set({ item: null, zones: [], hit: -1 })
}))
