export const TAB_DRAG_THRESHOLD = 4

export interface TabMoveKeyState {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export function moveToIndex<T>(list: readonly T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return list.slice()
  if (from < 0 || from >= list.length) return list.slice()
  const target = Math.max(0, Math.min(list.length - 1, to))
  if (target === from) return list.slice()
  const next = list.slice()
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

export function dropIndexFor(otherCentres: readonly number[], draggedCentre: number): number {
  return otherCentres.reduce((count, centre) => count + (draggedCentre > centre ? 1 : 0), 0)
}

export function dropGapIndex(toIndex: number, fromIndex: number): number {
  return toIndex >= fromIndex ? toIndex + 1 : toIndex
}

export function tabMoveKey(state: TabMoveKeyState): -1 | 1 | null {
  if (!(state.ctrl || state.meta) || !state.shift || state.alt) return null
  if (state.key === 'ArrowLeft') return -1
  if (state.key === 'ArrowRight') return 1
  return null
}
