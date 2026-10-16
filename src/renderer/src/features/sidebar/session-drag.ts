/**
 * 侧栏会话拖进对话区「分屏」的落点几何与瞬时状态。
 *
 * 侧栏行的指针拖拽是唯一写入方；落点层（SplitDropLayer）只读它显示预览。
 * 落点：单会话时是对话区的左右两半；分屏时是每一列的左右两半 ——
 * 第 i 列左半插到它前面（at = i），右半插到它后面（at = i + 1）。
 * 松手后交给正式 `useSplitView.open`（规则见 `placeInSplit`），这里不另存布局。
 */
import { create } from 'zustand'

/** 指针按下后移动超过这个距离（CSS px）才算拖拽，否则仍是点击。 */
export const DRAG_THRESHOLD = 6

export interface DropRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DropZone {
  /** 松手后插入到第几块的位置 */
  at: number
  side: 'left' | 'right'
  rect: DropRect
}

/**
 * 由列矩形算落点。`cols` 为空时（单会话）用 `area` 当作一列。
 * 太小的区域（窄窗、对话区被挤没）不给落点，调用方据此降级为不可拖放。
 */
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

/** 指针所在落点的下标；不在任何落点内为 -1。 */
export function hitDropZone(zones: readonly DropZone[], x: number, y: number): number {
  for (let i = 0; i < zones.length; i++) {
    const r = zones[i].rect
    if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return i
  }
  return -1
}

/** 是否越过拖拽阈值。 */
export function passedThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return dx * dx + dy * dy >= threshold * threshold
}

const toRect = (r: DOMRect): DropRect => ({ left: r.left, top: r.top, width: r.width, height: r.height })

/** 从当前 DOM 量落点：分屏时取各列，否则取对话区。 */
export function measureDropZones(): DropZone[] {
  if (typeof document === 'undefined') return []
  /* 窄窗只画焦点那一列，分屏放下去也看不到：明确降级为不可拖放 */
  if (document.querySelector('.v3-root[data-narrow="1"]')) return []
  const chat = document.querySelector<HTMLElement>('.v3-chat')
  if (!chat) return []
  const cols = [...chat.querySelectorAll<HTMLElement>('[data-testid="v3-split-col"]')].map((el) => toRect(el.getBoundingClientRect()))
  return dropZonesFor(toRect(chat.getBoundingClientRect()), cols)
}

export interface SessionDragState {
  /** 正在拖的会话；null = 没在拖 */
  item: { id: string; path: string; title: string } | null
  x: number
  y: number
  zones: DropZone[]
  /** 指针所在落点下标，-1 = 不在落点内 */
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
