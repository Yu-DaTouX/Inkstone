export const TILES_WIDTH_DEFAULT = 300
export const TILES_WIDTH_MIN = 260
export const TILES_WIDTH_MAX = 480
export const TILES_WIDTH_STEP = 16
export const TILES_WIDTH_KEY = 'inkstone.v3.tilesWidth'

export function clampTilesWidth(width: number, room: number = TILES_WIDTH_MAX): number {
  const ceiling = Math.max(TILES_WIDTH_MIN, Math.min(TILES_WIDTH_MAX, room))
  if (!Number.isFinite(width)) return Math.min(TILES_WIDTH_DEFAULT, ceiling)
  return Math.round(Math.min(ceiling, Math.max(TILES_WIDTH_MIN, width)))
}

export function tilesWidthRoom(laneWidth: number, laneGap: number, messageMin: number): number {
  return laneWidth - laneGap - messageMin
}

export function readTilesWidth(storage: Pick<Storage, 'getItem'> | null): number {
  try {
    const raw = storage?.getItem(TILES_WIDTH_KEY)
    if (raw === null || raw === undefined || raw === '') return TILES_WIDTH_DEFAULT
    const value = Number(raw)
    return Number.isFinite(value) ? clampTilesWidth(value) : TILES_WIDTH_DEFAULT
  } catch {
    return TILES_WIDTH_DEFAULT
  }
}

export function writeTilesWidth(storage: Pick<Storage, 'setItem'> | null, width: number): void {
  try {
    storage?.setItem(TILES_WIDTH_KEY, String(clampTilesWidth(width)))
  } catch {
    return
  }
}
