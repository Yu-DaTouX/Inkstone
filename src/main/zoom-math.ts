export const BASE_FS = 12.5

export const AUTO_TARGET = 14

export const SCALE_MIN = 0.6
export const SCALE_MAX = 3

export const SCALE_LADDER = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const

export function clampScale(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === 0) return 0
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n))
}

export function autoZoom(scaleFactor: number): number {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  const target = Math.round(AUTO_TARGET * sf) / sf
  return target / BASE_FS
}

export function effectiveZoom(uiScale: number, scaleFactor: number): number {
  const s = clampScale(uiScale)
  return s > 0 ? s : autoZoom(scaleFactor)
}

const MIN_STEP = 0.04

export function stepScaleFrom(cur: number, dir: 1 | -1): number {
  const min = Math.abs(cur) * MIN_STEP
  const rungs =
    dir > 0
      ? SCALE_LADDER.filter((v) => v > cur + min)
      : [...SCALE_LADDER].reverse().filter((v) => v < cur - min)
  if (rungs.length) return rungs[0]
  return dir > 0 ? SCALE_MAX : SCALE_MIN
}

export interface ZoomMath {
  uiScale: number
  effective: number
  autoScale: number
}

export function zoomMath(uiScale: unknown, scaleFactor: number): ZoomMath {
  const s = clampScale(uiScale)
  return {
    uiScale: s,
    effective: s > 0 ? s : autoZoom(scaleFactor),
    autoScale: autoZoom(scaleFactor)
  }
}
