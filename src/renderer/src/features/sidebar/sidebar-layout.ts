export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_WIDTH_DEFAULT = 288
export const SIDEBAR_WIDTH_STEP = 8
export const SIDEBAR_WIDTH_KEY = 'inkstone.v3.sidebarWidth'

const AUTO_COLLAPSE_FLOOR = 700
const AUTO_COLLAPSE_MAIN_ROOM = 329
const DOCKED_MAIN_ROOM = 330

export function sidebarMaxForWindow(windowWidth: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.floor(windowWidth) - DOCKED_MAIN_ROOM))
}

export function clampSidebarWidth(value: unknown): number {
  const width = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(width) || width <= 0) return SIDEBAR_WIDTH_DEFAULT
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width)))
}

export function readSidebarWidth(storage: Pick<Storage, 'getItem'> | null | undefined): number {
  try {
    return clampSidebarWidth(storage?.getItem(SIDEBAR_WIDTH_KEY) ?? null)
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export function sidebarCollapseWidth(sidebarWidth: number): number {
  return Math.max(AUTO_COLLAPSE_FLOOR, clampSidebarWidth(sidebarWidth) + AUTO_COLLAPSE_MAIN_ROOM)
}

export function shouldAutoCollapseSidebar(windowWidth: number, sidebarWidth: number): boolean {
  return windowWidth <= sidebarCollapseWidth(sidebarWidth)
}
