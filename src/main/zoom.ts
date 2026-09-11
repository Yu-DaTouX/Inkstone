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
 * 当前生效的缩放值（内存里的唯一真源）。
 *
 * ── 为什么需要它（这里曾经有过一个真 bug）──
 * 快捷键处理器原本是这么写的：
 *
 *     void getSettings().then((s) => setUiScale(stepScale(win, s.uiScale, 1)))
 *
 * 它每次都要**异步读盘**才知道当前值。而 setUiScale → patchSettings 是
 * 「invalidate 缓存 → 重读文件 → 写文件」的异步链。实测后果：
 * **连按两次 Ctrl+= 时第二下可能读到写盘之前的旧值**，于是算出与第一下
 * 相同的档位（看上去就是「按键丢了」）。探针里表现为
 * `1.152 → 1.3 → (无变化) → ...`，而且只在高负载/连续按键时出现。
 *
 * 现在：应用缩放时同步更新这个变量，快捷键直接读它 —— 热路径不碰磁盘，
 * 也没有竞态。设置里的值仍然会写（重启后保持）。
 *
 * `undefined` = 还没从设置里初始化过（启动早期）。
 */
let currentUiScale: number | undefined

/** 当前值（未初始化则当自动） */
export function peekUiScale(): number {
  return currentUiScale ?? 0
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

/** 应用缩放，返回生效后的状态。同时记住当前值（供快捷键同步读取） */
export function applyZoom(win: BrowserWindow | null, uiScale: unknown): ZoomState {
  const st = zoomState(win, uiScale)
  currentUiScale = st.uiScale
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(st.effective)
  return st
}

/** 沿档位梯子走一步（快捷键用），起点是当前**生效**倍率 */
export function stepScale(win: BrowserWindow | null, uiScale: unknown, dir: 1 | -1): number {
  const cur = effectiveZoom(clampScale(uiScale), displayScaleFactor(win))
  return stepScaleFrom(cur, dir)
}

export { clampScale, autoZoom, effectiveZoom }
