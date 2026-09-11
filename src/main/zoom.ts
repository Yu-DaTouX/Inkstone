/**
 * 界面缩放的 electron 部分（窗口 / 屏幕），纯计算在 zoom-math.ts。
 *
 * 为什么需要缩放
 * ---------------------------------------------------------------
 * ① **Electron 已经跟随系统缩放**（2560×1440 屏在 125% 下 → 逻辑 2048×1152，
 *    `scaleFactor = 1.25`，渲染端 `devicePixelRatio = 1.25`）。这一点不用我们做。
 *
 * ② 但设计基准正文是 **12.5px**，它是按「汉字格整数像素」定的 ——
 *    100% 缩放下恰好落在整数设备像素上。到了 125%：
 *
 *        12.5 × 1.25 = 15.625 设备像素   ← 非整数
 *
 *    中文在非整数设备像素下发虚（笔画粗细不均、字面偏小），
 *    而且 12.5px 在 2K 屏上本来也偏小。
 *
 * ③ 所以「自动」模式是：**先把目标字号对齐到整数设备像素，再换算成 zoom**。
 *    zoom 是唯一能同时放大字号、间距、边框的旋钮 ——
 *    只改 token 只能放大文字，「布局太小」这个抱怨改 token 解决不了。
 *
 * ④ 用户可手动覆盖（设置 → 外观，或 Ctrl+= / Ctrl+- / Ctrl+0）。
 *    `uiScale = 0` 表示自动。
 */
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
  /** 该窗口所在屏的系统缩放（1.25 = 125%） */
  scaleFactor: number
}

/**
 * 取窗口所在显示器的缩放系数。
 *
 * 用 `getDisplayMatching(win.getBounds())` 而不是 primaryDisplay：
 * 多屏且两屏缩放不同时（常见：笔记本 150% + 外接 100%），
 * 窗口拖到哪块屏就该按哪块屏算。
 */
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

/** 算一份完整状态，不改任何东西（给界面显示用） */
export function zoomState(win: BrowserWindow | null, uiScale: unknown): ZoomState {
  const sf = displayScaleFactor(win)
  const m = zoomMath(uiScale, sf)
  return { ...m, scaleFactor: sf }
}

/** 应用缩放，返回生效后的状态 */
export function applyZoom(win: BrowserWindow | null, uiScale: unknown): ZoomState {
  const st = zoomState(win, uiScale)
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(st.effective)
  return st
}

/** 沿档位梯子走一步（快捷键用），起点是当前**生效**倍率 */
export function stepScale(win: BrowserWindow | null, uiScale: unknown, dir: 1 | -1): number {
  const cur = effectiveZoom(clampScale(uiScale), displayScaleFactor(win))
  return stepScaleFrom(cur, dir)
}

export { clampScale, autoZoom, effectiveZoom }
