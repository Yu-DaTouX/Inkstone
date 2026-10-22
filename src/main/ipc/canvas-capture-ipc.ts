import { BrowserWindow } from 'electron'
import type { CanvasCaptureRect, CanvasCaptureResult } from '../../shared/ipc'
import { CANVAS_CAPTURE_CHANNEL } from '../../shared/ipc'
import type { IpcRegistrar } from './registrar'

export interface CanvasCaptureViewport {
  width: number
  height: number
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteScope(scope: unknown): CanvasCaptureRect | null {
  const raw = (scope ?? {}) as Record<string, unknown>
  const x = finite(raw.x)
  const y = finite(raw.y)
  const width = finite(raw.width)
  const height = finite(raw.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

export function clipCanvasRect(rect: unknown, viewport: CanvasCaptureViewport, scope?: unknown): CanvasCaptureRect | null {
  const raw = (rect ?? {}) as Record<string, unknown>
  const x = finite(raw.x)
  const y = finite(raw.y)
  const width = finite(raw.width)
  const height = finite(raw.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width < 1 || height < 1) return null
  const viewWidth = finite(viewport.width) ?? 0
  const viewHeight = finite(viewport.height) ?? 0
  if (viewWidth < 1 || viewHeight < 1) return null
  const bounds = finiteScope(scope)
  const startX = bounds ? Math.max(x, bounds.x) : x
  const startY = bounds ? Math.max(y, bounds.y) : y
  const endX = bounds ? Math.min(x + width, bounds.x + bounds.width) : x + width
  const endY = bounds ? Math.min(y + height, bounds.y + bounds.height) : y + height
  const left = Math.max(0, Math.floor(startX))
  const top = Math.max(0, Math.floor(startY))
  const right = Math.min(viewWidth, Math.ceil(endX))
  const bottom = Math.min(viewHeight, Math.ceil(endY))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function scaleCanvasRect(rect: CanvasCaptureRect, factor: number): CanvasCaptureRect {
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1
  const left = Math.floor(rect.x * scale)
  const top = Math.floor(rect.y * scale)
  const right = Math.ceil((rect.x + rect.width) * scale)
  const bottom = Math.ceil((rect.y + rect.height) * scale)
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

function failure(error: string): CanvasCaptureResult {
  return { ok: false, error }
}

export function registerCanvasCaptureIpc(ipc: IpcRegistrar): void {
  ipc.rawHandle(CANVAS_CAPTURE_CHANNEL, async (event, rect: unknown, scope: unknown): Promise<CanvasCaptureResult> => {
    const contents = event.sender
    if (!contents || contents.isDestroyed()) return failure('窗口不可用，无法截图')
    const bounds = BrowserWindow.fromWebContents(contents)?.getContentBounds()
    if (!bounds || bounds.width < 1 || bounds.height < 1) return failure('窗口尚未就绪，无法截图')
    const zoom = contents.getZoomFactor() || 1
    const cssRect = clipCanvasRect(rect, { width: bounds.width / zoom, height: bounds.height / zoom }, scope)
    if (!cssRect) return failure('截图区域无效')
    const dipRect = scaleCanvasRect(cssRect, zoom)
    let image: Electron.NativeImage
    try {
      image = await contents.capturePage(dipRect)
    } catch (e) {
      return failure(`截图失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!image || image.isEmpty()) return failure('截图为空，请确认区域在可见窗口内')
    const png = image.toPNG()
    if (png.byteLength === 0) return failure('截图为空，请确认区域在可见窗口内')
    const { width, height } = image.getSize()
    return {
      ok: true,
      data: png.toString('base64'),
      width,
      height,
      scaleFactor: dipRect.width > 0 ? width / dipRect.width : 1
    }
  })
}
