import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { HtmlArtifactPreviewStore } from './html-artifact-preview-store'
import { delay } from '../shared/delay'

export const IMAGE_EXPORT_DEFAULT_WIDTH = 1280
export const IMAGE_EXPORT_MAX_SIDE = 8000
export const IMAGE_EXPORT_DEFAULT_SCALE = 2
export const IMAGE_EXPORT_MAX_SCALE = 4

const LOAD_TIMEOUT_MS = 15_000
const STEP_TIMEOUT_MS = 15_000
const SETTLE_MS = 400

export type ImageExportErrorCode = 'bad-request' | 'load-failed' | 'selector-missing' | 'capture-failed' | 'export-busy'

export class ImageExportError extends Error {
  constructor(readonly code: ImageExportErrorCode, message: string) {
    super(message)
  }
}

export interface ImageExportInput {
  previews: HtmlArtifactPreviewStore
  htmlPath: string
  root: string
  outPath?: string
  width?: number
  height?: number
  scale?: number
  selector?: string
}

export interface ImageExportOutput {
  path: string
  width: number
  height: number
  scale: number
  pixelWidth: number
  pixelHeight: number
  target: 'selector' | 'poster' | 'page'
  bytes: number
  consoleErrors: string[]
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function uniqueImagePath(target: string, taken: (path: string) => boolean): string {
  if (!taken(target)) return target
  const ext = extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem}-${Date.now().toString(36)}${ext}`
}

export function defaultImagePath(htmlPath: string, taken: (path: string) => boolean): string {
  const name = basename(htmlPath, extname(htmlPath))
  return uniqueImagePath(join(dirname(htmlPath), `${name}.png`), taken)
}

export function clampScale(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return IMAGE_EXPORT_DEFAULT_SCALE
  return Math.min(IMAGE_EXPORT_MAX_SCALE, Math.max(0.5, value))
}

function clampSide(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(IMAGE_EXPORT_MAX_SIDE, Math.max(64, Math.round(value)))
}

async function within<T>(work: Promise<T>, code: ImageExportErrorCode, label: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ImageExportError(code, `${label} 超过 ${Math.round(ms / 1000)} 秒没有完成`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const POSTER_PROBE = `(() => {
  const viewport = document.documentElement.clientWidth
  const visible = (el) => {
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT'].includes(el.tagName)) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  let node = document.body
  for (let depth = 0; node && depth < 3; depth += 1) {
    const kids = Array.from(node.children).filter(visible)
    if (kids.length !== 1) break
    node = kids[0]
    const rect = node.getBoundingClientRect()
    if (rect.width < viewport - 16) {
      return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
    }
  }
  return null
})()`

function selectorProbe(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
  })()`
}

let busy = false

export async function exportHtmlImage(input: ImageExportInput): Promise<ImageExportOutput> {
  if (busy) throw new ImageExportError('export-busy', '已经有一张图在导出，等它结束再试')
  busy = true
  try {
    return await runImageExport(input)
  } finally {
    busy = false
  }
}

async function runImageExport(input: ImageExportInput): Promise<ImageExportOutput> {
  const prepared = await input.previews.prepare(input.htmlPath, input.root)
  if (!prepared.ok) {
    if (prepared.error === 'outside') throw new ImageExportError('bad-request', 'HTML 文件必须在当前项目目录内')
    if (prepared.error === 'type') throw new ImageExportError('bad-request', '只支持 .html / .htm 文件')
    if (prepared.error === 'size') throw new ImageExportError('bad-request', 'HTML 文件为空或超过 5MB')
    if (prepared.error === 'busy') throw new ImageExportError('export-busy', '同时渲染的预览太多，等它们结束再试')
    throw new ImageExportError('load-failed', '读不了这个 HTML 文件')
  }
  const width = clampSide(input.width, IMAGE_EXPORT_DEFAULT_WIDTH)
  const height = clampSide(input.height, 800)
  const scale = clampScale(input.scale)
  const consoleErrors: string[] = []
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level?: string | number }).level
    if ((level === 'error' || level === 3) && consoleErrors.length < 20) consoleErrors.push(String((details as unknown as { message?: string }).message ?? '').slice(0, 300))
  })
  const dbg = win.webContents.debugger
  try {
    await within(win.loadURL(prepared.url), 'load-failed', '加载页面', LOAD_TIMEOUT_MS)
    await within(
      win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true))', true),
      'load-failed',
      '等待字体'
    ).catch(() => true)
    await delay(SETTLE_MS)

    let target: ImageExportOutput['target'] = 'page'
    let clip: Rect | null = null
    if (input.selector) {
      clip = (await within(win.webContents.executeJavaScript(selectorProbe(input.selector), true), 'capture-failed', '查找元素')) as Rect | null
      if (!clip) throw new ImageExportError('selector-missing', `页面里找不到 ${input.selector}`)
      target = 'selector'
    } else if (input.width === undefined && input.height === undefined) {
      clip = (await within(win.webContents.executeJavaScript(POSTER_PROBE, true), 'capture-failed', '识别海报区域').catch(() => null)) as Rect | null
      if (clip) target = 'poster'
    }
    if (!clip) {
      const pageHeight = Number(
        await within(
          win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true),
          'capture-failed',
          '测量页面'
        ).catch(() => height)
      ) || height
      clip = { x: 0, y: 0, width, height: input.height === undefined ? Math.min(IMAGE_EXPORT_MAX_SIDE, pageHeight) : height }
    }
    const rect = {
      x: Math.max(0, Math.floor(clip.x)),
      y: Math.max(0, Math.floor(clip.y)),
      width: Math.max(1, Math.min(IMAGE_EXPORT_MAX_SIDE, Math.ceil(clip.width))),
      height: Math.max(1, Math.min(IMAGE_EXPORT_MAX_SIDE, Math.ceil(clip.height)))
    }

    dbg.attach('1.3')
    const shot = (await within(
      dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale } }),
      'capture-failed',
      '截图'
    )) as { data?: string }
    if (!shot?.data) throw new ImageExportError('capture-failed', '截图结果是空的')
    const png = Buffer.from(shot.data, 'base64')
    const outPath = input.outPath ? uniqueImagePath(input.outPath, existsSync) : defaultImagePath(input.htmlPath, existsSync)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, png)
    const info = await stat(outPath)
    return {
      path: outPath,
      width: rect.width,
      height: rect.height,
      scale,
      pixelWidth: Math.round(rect.width * scale),
      pixelHeight: Math.round(rect.height * scale),
      target,
      bytes: info.size,
      consoleErrors
    }
  } finally {
    if (dbg.isAttached()) dbg.detach()
    input.previews.release(prepared.url)
    if (!win.isDestroyed()) win.destroy()
  }
}
