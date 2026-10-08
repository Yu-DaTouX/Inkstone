/**
 * 拖会话进工作区「分屏」落点的瞬时状态。
 *
 * 左栏的指针拖拽（Rail）是唯一写入方；落点层（SplitDropZone）只读它来显示高亮。
 * 落点几何由 `splitDropZones` 统一给出，写入方与显示方用同一份，避免两边算出不同的区域。
 */
import { create } from 'zustand'

interface SplitDropState {
  /** 正在拖一条会话（还没进落点时只显示提示，不高亮） */
  dragging: boolean
  /** 指针在第几个落点内（`splitDropZones` 的下标，只用来高亮）；不在落点内为 null */
  zone: number | null
  /** 该落点松手后插入的位置（0..块数）；不在落点内为 null */
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
  /** 松手后插入到第几块的位置 */
  at: number
  rect: DOMRect
}

/**
 * 落点：每块会话磁贴的左半 / 右半。落在第 i 块的左半 = 插到它前面（at = i），
 * 右半 = 插到它后面（at = i + 1）。还没分屏时只有主会话一块，等于工作区的左右两半。
 * 已满 5 块时松手会挤掉离落点最近的、没有焦点的一块（见 `placeInSplit`）。
 */
export function splitDropZones(): SplitDropZoneRect[] | null {
  const canvas = document.querySelector('.tile-workspace-canvas')
  if (!canvas) return null
  const base = canvas.getBoundingClientRect()
  if (base.width < 200 || base.height < 120) return null
  const frames = [...canvas.querySelectorAll<HTMLElement>('.tile-frame.primary')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 40 && r.height > 40)
    .sort((a, b) => a.left - b.left)
  /* 取不到磁贴（布局最大化、测试夹具）就退回整个画布当一块 */
  const tiles = frames.length ? frames : [base]
  const out: SplitDropZoneRect[] = []
  tiles.forEach((r, i) => {
    const half = r.width / 2
    out.push({ at: i, rect: new DOMRect(r.left, r.top, half, r.height) })
    out.push({ at: i + 1, rect: new DOMRect(r.left + half, r.top, half, r.height) })
  })
  return out
}

/** 指针所在的落点；不在任何落点内为 null */
export function splitDropHit(x: number, y: number): { zone: number; at: number } | null {
  const zones = splitDropZones()
  if (!zones) return null
  for (let i = 0; i < zones.length; i++) {
    const r = zones[i].rect
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { zone: i, at: zones[i].at }
  }
  return null
}
