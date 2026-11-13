export const TAB_DRAG_THRESHOLD = 4

export interface TabMoveKeyState {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
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
