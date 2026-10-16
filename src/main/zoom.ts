import { screen, type BrowserWindow } from 'electron'
import {
  autoZoom,
  clampScale,
  effectiveZoom,
  stepScaleFrom,
  zoomMath,
  type ZoomMath
} from './zoom-math'

export interface ZoomState extends ZoomMath {
  scaleFactor: number
}

let currentUiScale: number | undefined

export function peekUiScale(): number {
  return currentUiScale ?? 0
}

export function displayScaleFactor(win?: BrowserWindow | null): number {
  try {
    const d =
      win && !win.isDestroyed()
        ? screen.getDisplayMatching(win.getBounds())
        : screen.getPrimaryDisplay()
    return d?.scaleFactor && d.scaleFactor > 0 ? d.scaleFactor : 1
  } catch {
    return 1
  }
}

export function zoomState(win: BrowserWindow | null, uiScale: unknown): ZoomState {
  const sf = displayScaleFactor(win)
  const m = zoomMath(uiScale, sf)
  return { ...m, scaleFactor: sf }
}

export function applyZoom(win: BrowserWindow | null, uiScale: unknown): ZoomState {
  const st = zoomState(win, uiScale)
  currentUiScale = st.uiScale
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(st.effective)
  return st
}

export function stepScale(win: BrowserWindow | null, uiScale: unknown, dir: 1 | -1): number {
  const cur = effectiveZoom(clampScale(uiScale), displayScaleFactor(win))
  return stepScaleFrom(cur, dir)
}

export { clampScale, autoZoom, effectiveZoom }
