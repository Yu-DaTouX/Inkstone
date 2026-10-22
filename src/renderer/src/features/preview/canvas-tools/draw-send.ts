import type { Attachment } from '../../../../../shared/ipc'
import type { PreviewText } from '../preview-text'
import { captureElementRegion, composeAnnotatedImage, sendToChat } from '../canvas-share'
import {
  DRAW_FOCUS_PADDING,
  DRAW_REGION_MARGIN,
  captureRegion,
  exportSvg,
  rectClamp,
  rectExpand,
  shapeTextLabels,
  shapesBounds,
  visibleBoxRegion,
  type DrawShape
} from './draw-model'
import { drawText, type DrawPromptEntry } from './draw-text'
import { drawFrameShapes, setDrawCaptureHidden } from './draw-store'
import type { CanvasToolContext } from './types'

export type DrawSendReason = 'sent' | 'empty' | 'chat' | 'failed'

export interface DrawSendOutcome {
  ok: boolean
  images: number
  reason: DrawSendReason
}

function deviceName(labels: PreviewText, id: string): string {
  if (id === 'desktop') return labels.canvasDeviceDesktop
  if (id === 'laptop') return labels.canvasDeviceLaptop
  if (id === 'tablet') return labels.canvasDeviceTablet
  if (id === 'phone') return labels.canvasDevicePhone
  return labels.canvasDeviceCustom
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 60)))
  })
}

export async function sendDrawings(
  context: CanvasToolContext,
  stage: HTMLElement | null,
  frameIds: readonly string[]
): Promise<DrawSendOutcome> {
  const entries = context.frames
    .filter((frame) => frameIds.includes(frame.viewport.id))
    .map((frame) => ({ frame, shapes: drawFrameShapes(context.abs, frame.viewport.id) as DrawShape[] }))
    .filter((entry) => entry.shapes.length > 0)
  const images: Attachment[] = []
  if (!entries.length) return { ok: false, images: 0, reason: 'empty' }
  const text = drawText(context.labels.lang)
  const prompts: DrawPromptEntry[] = []
  const chrome = stage?.parentElement
    ? Array.from(stage.parentElement.querySelectorAll<HTMLElement>('.v3-canvas-toolbar, .v3-canvas-agent'))
    : []
  const chromeVisibility = chrome.map((element) => element.style.visibility)
  for (const element of chrome) element.style.visibility = 'hidden'
  setDrawCaptureHidden(true)
  try {
    for (const entry of entries) {
      const { frame, shapes } = entry
      const frameSize = { width: frame.viewport.width, height: frame.viewport.height }
      const frameRect = { x: 0, y: 0, w: frameSize.width, h: frameSize.height }
      const bounds = shapesBounds(shapes) ?? frameRect
      const target = rectClamp(rectExpand(bounds, DRAW_REGION_MARGIN), frameRect)
      await context.focusRect(frame.viewport.id, target, DRAW_FOCUS_PADDING)
      await nextPaint()
      const element = context.frameElement(frame.viewport.id)
      if (!element) continue
      const elementBox = element.getBoundingClientRect()
      const scale = elementBox.width > 0 ? elementBox.width / frameSize.width : 0
      if (!(scale > 0)) continue
      const stageBox = stage?.getBoundingClientRect()
      const visible = stageBox
        ? visibleBoxRegion(
            frameSize,
            { x: elementBox.left, y: elementBox.top, w: elementBox.width, h: elementBox.height },
            { x: stageBox.left, y: stageBox.top, w: stageBox.width, h: stageBox.height }
          )
        : frameRect
      const region = captureRegion(shapes, visible, frameSize, DRAW_REGION_MARGIN)
      const inner = { x: region.x * scale, y: region.y * scale, w: region.w * scale, h: region.h * scale }
      const scope = stageBox ? { x: stageBox.left, y: stageBox.top, w: stageBox.width, h: stageBox.height } : undefined
      const shot = await captureElementRegion(element, inner, undefined, scope)
      const composed = await composeAnnotatedImage(shot, exportSvg(shapes, region, 1 / scale))
      images.push(composed)
      prompts.push({
        name: context.name,
        frame: deviceName(context.labels, frame.viewport.id),
        width: Math.round(frameSize.width),
        height: Math.round(frameSize.height),
        texts: shapeTextLabels(shapes),
        time: context.currentTime
      })
    }
    if (!images.length) return { ok: false, images: 0, reason: 'failed' }
    const body = prompts.map((entry) => text.prompt(entry)).join('\n\n')
    const ok = sendToChat({ text: body, images })
    return { ok, images: images.length, reason: ok ? 'sent' : 'chat' }
  } catch {
    return { ok: false, images: images.length, reason: 'failed' }
  } finally {
    setDrawCaptureHidden(false)
    chrome.forEach((element, index) => {
      element.style.visibility = chromeVisibility[index]
    })
  }
}
