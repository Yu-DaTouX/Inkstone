/**
 * 原生 WebContentsView 的占位坐标计算（纯函数 + 一个可单测的同步器）。
 *
 * 坐标语义（与主进程 `browser.ts#setBounds` 的约定一致）：
 *   渲染端发过去的是**主窗口渲染进程的 CSS 像素**；主进程再乘以 webContents
 *   的 `zoomFactor` 换成 DIP。所以这里只做 CSS 像素的裁剪与量化，不自己换算
 *   缩放 —— 换算两处都做就会双重缩放。
 */

/** 最小可测的矩形接口，`DOMRect` 与测试夹具都满足。 */
export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** 发给 `window.yan.browser.setBounds` 的坐标。 */
export interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 量化步长：半个 CSS 像素，既抑制抖动又跟得上过渡动画。 */
export const BOUNDS_QUANTUM = 0.5

/** 把矩形量化到 `BOUNDS_QUANTUM` 的网格（最小 0）。 */
function quantize(value: number): number {
  return Math.max(0, Math.round(value / BOUNDS_QUANTUM) * BOUNDS_QUANTUM)
}

/**
 * 取「占位区 ∩ 滚动裁剪区」。裁剪区为空（没有滚动容器）时用占位区本身。
 *
 * 磁贴被父级滚动容器裁掉一半时，原生视图也必须只露那一半，不能超出容器。
 */
export function clipToRect(rect: RectLike, clip: RectLike | null): { left: number; top: number; right: number; bottom: number } {
  return {
    left: clip ? Math.max(rect.left, clip.left) : rect.left,
    top: clip ? Math.max(rect.top, clip.top) : rect.top,
    right: clip ? Math.min(rect.right, clip.right) : rect.right,
    bottom: clip ? Math.min(rect.bottom, clip.bottom) : rect.bottom
  }
}

/**
 * 计算原生视图坐标。宽高被裁到 0 时返回 0 尺寸（主进程会把 0 抬成 1px，
 * 但那时面板会同时把原生层置为不可见）。
 */
export function nativeBoundsFor(rect: RectLike, clip: RectLike | null = null): NativeBounds {
  const box = clipToRect(rect, clip)
  const width = Math.max(0, box.right - box.left)
  const height = Math.max(0, box.bottom - box.top)
  return {
    x: quantize(box.left),
    y: quantize(box.top),
    width: quantize(width),
    height: quantize(height)
  }
}

/** 坐标签名：与上一帧比对，几何没变就不重复发 IPC。 */
export function boundsSignature(bounds: NativeBounds): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

/** 可见面积；用于判断磁贴是否被完全滚出裁剪区。 */
export function boundsArea(bounds: NativeBounds): number {
  return bounds.width * bounds.height
}

/** 只依赖 `setBounds` 的桥（组件传 `window.yan.browser`，测试传桩）。 */
export interface BoundsBridge {
  setBounds(bounds: NativeBounds): void | Promise<void>
}

/**
 * 有记忆的坐标同步器：几何签名不变就不发 IPC。
 *
 * 为什么要它单独存在：`BrowserPane` 用一个逐帧测量循环跟随滚动、列宽过渡与
 * 缩放，中间会反复量到相同坐标；去重逻辑是「不打扰原生层」的关键，必须能
 * 脱离 React 单测。
 */
export class BrowserBoundsSync {
  private last = ''

  constructor(private readonly bridge: BoundsBridge) {}

  /** 量一次并（必要时）发送；返回本次坐标，输入为空时返回 null。 */
  sync(rect: RectLike | null, clip: RectLike | null = null): NativeBounds | null {
    if (!rect) return null
    const bounds = nativeBoundsFor(rect, clip)
    const signature = boundsSignature(bounds)
    if (signature === this.last) return bounds
    this.last = signature
    void this.bridge.setBounds(bounds)
    return bounds
  }

  /** 归属/显隐切换后调用：下一次量到相同坐标也要重新发送。 */
  reset(): void {
    this.last = ''
  }
}
