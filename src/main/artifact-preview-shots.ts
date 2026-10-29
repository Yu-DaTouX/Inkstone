import { BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HtmlArtifactPreviewStore } from './html-artifact-preview-store'
import {
  PREVIEW_VIDEO_OVERFLOW_SLACK_PX,
  PREVIEW_VIDEO_TIMELINE_TIMEOUT_MS,
  VIDEO_COMPOSITION_PROBE,
  normalizeVideoComposition,
  previewSampleLabel,
  previewSampleTimes,
  roundSampleTime,
  videoPreviewPixelSize,
  videoSeekScript,
  type VideoCompositionInfo
} from './video-composition'
import { delay } from '../shared/delay'

const PREVIEW_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PREVIEW_DIR_KEEP = 30

export async function pruneOldPreviewDirs(outDir: string, now = Date.now()): Promise<void> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => [])
  const dirs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
    .map(async (entry) => ({ path: join(outDir, entry.name), at: (await stat(join(outDir, entry.name)).catch(() => null))?.mtimeMs ?? 0 })))
  dirs.sort((a, b) => b.at - a.at)
  for (const [index, dir] of dirs.entries()) {
    if (index >= PREVIEW_DIR_KEEP || now - dir.at > PREVIEW_DIR_MAX_AGE_MS) await rm(dir.path, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface PreviewShot {
  scheme: 'light' | 'dark'
  viewport: 'desktop' | 'narrow'
  width: number
  height: number
  path: string
  horizontalOverflow: boolean
  pageHeight: number
  screens: number
  truncated: boolean
}

export interface PreviewVideoSample {
  at: number
  path: string
  overflow: string[]
  seeked: boolean
}

export interface PreviewVideoShots {
  compositionId: string
  width: number
  height: number
  duration: number
  timelineReady: boolean
  screenWidth: number
  screenHeight: number
  sheetPath: string
  samples: PreviewVideoSample[]
}

export interface PreviewShotsResult {
  shots: PreviewShot[]
  consoleErrors: string[]
  loadError?: string
  video?: PreviewVideoShots
}

const VIEWPORTS = [
  { viewport: 'desktop', width: 1280, height: 800, columns: 2 },
  { viewport: 'narrow', width: 390, height: 844, columns: 4 }
] as const

const MAX_SCREENS = 4
const SHEET_GAP = 16
const SHEET_BG = [0x80, 0x80, 0x80, 0xff] as const
const SCROLL_SETTLE_MS = 180
const SCREEN_SLACK = 48
const TIMELINE_POLL_MS = 100

const SCHEMES = ['light', 'dark'] as const
const SETTLE_MS = 600
const STEP_TIMEOUT_MS = 15000

const GLYPHS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  't': ['010', '111', '010', '010', '011'],
  '=': ['000', '111', '000', '111', '000'],
  's': ['011', '100', '010', '001', '110'],
  ' ': ['000', '000', '000', '000', '000']
}
const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5
const GLYPH_ADVANCE = 4
const LABEL_PADDING = 8
const LABEL_BG = [0x00, 0x00, 0x00, 0xff] as const
const LABEL_FG = [0xff, 0xff, 0xff, 0xff] as const

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), STEP_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function screenOffsets(pageHeight: number, viewportHeight: number): { offsets: number[]; truncated: boolean } {
  const offsets: number[] = []
  for (let y = 0; (y === 0 || y < pageHeight - SCREEN_SLACK) && offsets.length < MAX_SCREENS; y += viewportHeight) offsets.push(Math.min(y, Math.max(0, pageHeight - viewportHeight)))
  const truncated = pageHeight > viewportHeight * MAX_SCREENS + SCREEN_SLACK
  if (truncated) offsets[offsets.length - 1] = Math.max(0, pageHeight - viewportHeight)
  const unique = offsets.filter((y, index) => index === 0 || y !== offsets[index - 1])
  return { offsets: unique, truncated }
}

export function composeSheet(screens: NativeImage[], width: number, height: number, columns: number): NativeImage {
  if (screens.length === 1) return screens[0]
  const cols = Math.min(columns, screens.length)
  const rows = Math.ceil(screens.length / cols)
  const sheetWidth = cols * width + (cols - 1) * SHEET_GAP
  const sheetHeight = rows * height + (rows - 1) * SHEET_GAP
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4)
  for (let i = 0; i < sheet.length; i += 4) sheet.set(SHEET_BG, i)
  screens.forEach((screen, index) => {
    const sized = screen.getSize().width === width && screen.getSize().height === height ? screen : screen.resize({ width, height })
    const bitmap = sized.toBitmap()
    const left = (index % cols) * (width + SHEET_GAP)
    const top = Math.floor(index / cols) * (height + SHEET_GAP)
    for (let row = 0; row < height; row++) bitmap.copy(sheet, ((top + row) * sheetWidth + left) * 4, row * width * 4, (row + 1) * width * 4)
  })
  return nativeImage.createFromBitmap(sheet, { width: sheetWidth, height: sheetHeight })
}

function fillRect(buffer: Buffer, stride: number, x: number, y: number, width: number, height: number, color: readonly number[]): void {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const offset = (row * stride + col) * 4
      buffer[offset] = color[0]
      buffer[offset + 1] = color[1]
      buffer[offset + 2] = color[2]
      buffer[offset + 3] = color[3]
    }
  }
}

function labelScale(text: string, width: number): number {
  const step = text.length * GLYPH_ADVANCE
  if (step <= 0) return 1
  return Math.max(1, Math.min(4, Math.floor((width - LABEL_PADDING * 2) / step)))
}

function drawLabel(buffer: Buffer, stride: number, x: number, y: number, text: string, scale: number): void {
  const glyphHeight = GLYPH_HEIGHT * scale
  fillRect(buffer, stride, x - LABEL_PADDING, y - LABEL_PADDING, text.length * GLYPH_ADVANCE * scale + LABEL_PADDING * 2, glyphHeight + LABEL_PADDING * 2, LABEL_BG)
  let cursor = x
  for (const char of text) {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (glyph[row][col] !== '1') continue
        fillRect(buffer, stride, cursor + col * scale, y + row * scale, scale, scale, LABEL_FG)
      }
    }
    cursor += GLYPH_ADVANCE * scale
  }
}

function sheetColumns(count: number, width: number, height: number): number {
  if (count <= 1) return 1
  const ideal = Math.ceil(Math.sqrt((count * height) / Math.max(1, width)))
  return Math.max(1, Math.min(4, ideal))
}

export function composeVideoSheet(tiles: { image: NativeImage; label: string }[], width: number, height: number, columns: number): NativeImage {
  if (tiles.length === 1) {
    const single = tiles[0].image.getSize().width === width && tiles[0].image.getSize().height === height
      ? tiles[0].image
      : tiles[0].image.resize({ width, height })
    const bitmap = Buffer.from(single.toBitmap())
    drawLabel(bitmap, width, LABEL_PADDING, height - LABEL_PADDING - GLYPH_HEIGHT * labelScale(tiles[0].label, width), tiles[0].label, labelScale(tiles[0].label, width))
    return nativeImage.createFromBitmap(bitmap, { width, height })
  }
  const cols = Math.max(1, Math.min(columns, tiles.length))
  const rows = Math.ceil(tiles.length / cols)
  const sheetWidth = cols * width + (cols - 1) * SHEET_GAP
  const sheetHeight = rows * height + (rows - 1) * SHEET_GAP
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4)
  for (let i = 0; i < sheet.length; i += 4) sheet.set(SHEET_BG, i)
  tiles.forEach((tile, index) => {
    const sized = tile.image.getSize().width === width && tile.image.getSize().height === height ? tile.image : tile.image.resize({ width, height })
    const bitmap = sized.toBitmap()
    const left = (index % cols) * (width + SHEET_GAP)
    const top = Math.floor(index / cols) * (height + SHEET_GAP)
    for (let row = 0; row < height; row++) bitmap.copy(sheet, ((top + row) * sheetWidth + left) * 4, row * width * 4, (row + 1) * width * 4)
    const scale = labelScale(tile.label, width)
    drawLabel(sheet, sheetWidth, left + LABEL_PADDING, top + height - LABEL_PADDING * 2 - GLYPH_HEIGHT * scale, tile.label, scale)
  })
  return nativeImage.createFromBitmap(sheet, { width: sheetWidth, height: sheetHeight })
}

function overflowScript(slack: number): string {
  return `(() => {
  const stage = document.querySelector('[data-composition-id]');
  if (!stage) return [];
  const box = stage.getBoundingClientRect();
  const slack = ${slack};
  const found = [];
  const nodes = stage.querySelectorAll('*');
  for (let index = 0; index < nodes.length && found.length < 4; index++) {
    const el = nodes[index];
    if (typeof el.checkVisibility === 'function') {
      let visible = true;
      try { visible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }); } catch (_) { visible = true; }
      if (!visible) continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const dx = Math.max(box.left - rect.left, rect.right - box.right, 0);
    const dy = Math.max(box.top - rect.top, rect.bottom - box.bottom, 0);
    if (dx <= slack && dy <= slack) continue;
    const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
    const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
    found.push(name + ' 超出画框 ' + Math.round(dx) + 'x' + Math.round(dy) + 'px');
  }
  return found;
})()`
}

async function readComposition(win: BrowserWindow): Promise<VideoCompositionInfo | null> {
  const value = await within(win.webContents.executeJavaScript(VIDEO_COMPOSITION_PROBE, true), 'probe')
  return normalizeVideoComposition(value)
}

async function settleComposition(win: BrowserWindow, first: VideoCompositionInfo): Promise<VideoCompositionInfo> {
  let composition = first
  const deadline = Date.now() + PREVIEW_VIDEO_TIMELINE_TIMEOUT_MS
  while (!composition.ready && Date.now() < deadline) {
    await delay(TIMELINE_POLL_MS)
    const next = await readComposition(win)
    if (!next) return composition
    composition = next
  }
  return composition
}

async function captureVideoShots(input: {
  win: BrowserWindow
  composition: VideoCompositionInfo
  dir: string
  at?: number[]
}): Promise<PreviewVideoShots> {
  const { win, composition, dir } = input
  const size = videoPreviewPixelSize(composition.width, composition.height)
  win.setContentSize(size.width, size.height)
  win.webContents.enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width: size.width, height: size.height },
    viewPosition: { x: 0, y: 0 },
    viewSize: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    scale: 1
  })
  win.webContents.setZoomFactor(size.zoom)
  await delay(SETTLE_MS)
  const planned = previewSampleTimes({ duration: composition.duration, clips: composition.clips, at: input.at })
  const times = planned.length ? planned : [0]
  const samples: PreviewVideoSample[] = []
  const tiles: { image: NativeImage; label: string }[] = []
  for (const time of times) {
    const seeked = await within(win.webContents.executeJavaScript(videoSeekScript(composition.id, time), true), 'seek')
      .then((value) => value === true)
      .catch(() => false)
    const overflow = await within(win.webContents.executeJavaScript(overflowScript(PREVIEW_VIDEO_OVERFLOW_SLACK_PX), true), 'measure')
      .then((value) => (Array.isArray(value) ? value.map((item) => String(item)).slice(0, 4) : []))
      .catch(() => [])
    const image = await within(win.webContents.capturePage(), 'capture')
    if (image.isEmpty()) throw new Error('capture_empty')
    const actual = image.getSize()
    const frame = actual.width === size.width && actual.height === size.height
      ? image
      : image.resize({ width: size.width, height: size.height, quality: 'best' })
    const path = join(dir, `t-${roundSampleTime(time)}.png`)
    await writeFile(path, frame.toPNG())
    samples.push({ at: time, path, overflow, seeked })
    tiles.push({ image: frame, label: previewSampleLabel(time) })
  }
  const sheetPath = join(dir, 'sheet.png')
  const sheet = composeVideoSheet(tiles, size.width, size.height, sheetColumns(tiles.length, size.width, size.height))
  await writeFile(sheetPath, sheet.toPNG())
  return {
    compositionId: composition.id,
    width: composition.width,
    height: composition.height,
    duration: composition.duration,
    timelineReady: composition.ready,
    screenWidth: size.width,
    screenHeight: size.height,
    sheetPath,
    samples
  }
}

export async function captureHtmlPreviewShots(input: {
  previews: HtmlArtifactPreviewStore
  htmlPath: string
  root: string
  outDir: string
  at?: number[]
}): Promise<PreviewShotsResult> {
  const prepared = await input.previews.prepare(input.htmlPath, input.root)
  if (!prepared.ok) throw new Error(`preview_${prepared.error}`)
  const consoleErrors: string[] = []
  const win = new BrowserWindow({
    show: false,
    width: VIEWPORTS[0].width,
    height: VIEWPORTS[0].height,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true }
  })
  win.webContents.setFrameRate(10)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level?: string | number }).level
    if ((level === 'error' || level === 3) && consoleErrors.length < 20) consoleErrors.push(String((details as unknown as { message?: string }).message ?? '').slice(0, 400))
  })
  await pruneOldPreviewDirs(input.outDir).catch(() => undefined)
  const dir = join(input.outDir, randomUUID())
  await mkdir(dir, { recursive: true })
  const shots: PreviewShot[] = []
  try {
    try {
      await within(win.loadURL(prepared.url), 'load')
    } catch (error) {
      return { shots, consoleErrors, loadError: error instanceof Error ? error.message : String(error) }
    }
    const detected = await readComposition(win).catch(() => null)
    if (detected) {
      await within(
        win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true))', true),
        'fonts'
      ).catch(() => true)
      const composition = await settleComposition(win, detected)
      return { shots, consoleErrors, video: await captureVideoShots({ win, composition, dir, at: input.at }) }
    }
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    try {
      for (const scheme of SCHEMES) {
        await within(dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }), 'media')
        for (const view of VIEWPORTS) {
          win.setContentSize(view.width, view.height)
          await delay(SETTLE_MS)
          const overflow = await within(
            win.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth + 1', true),
            'measure'
          ).catch(() => false)
          const pageHeight = Number(
            await within(
              win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true),
              'measure'
            ).catch(() => view.height)
          ) || view.height
          const plan = screenOffsets(pageHeight, view.height)
          const screens: NativeImage[] = []
          for (const y of plan.offsets) {
            await within(win.webContents.executeJavaScript(`window.scrollTo({ top: ${y}, left: 0, behavior: 'instant' }); true`, true), 'scroll').catch(() => false)
            await delay(SCROLL_SETTLE_MS)
            const image = await within(win.webContents.capturePage(), 'capture')
            if (image.isEmpty()) throw new Error('capture_empty')
            screens.push(image)
          }
          await within(win.webContents.executeJavaScript("window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); true", true), 'scroll').catch(() => false)
          const sheet = composeSheet(screens, view.width, view.height, view.columns)
          const path = join(dir, `${scheme}-${view.viewport}.png`)
          await writeFile(path, sheet.toPNG())
          shots.push({ scheme, viewport: view.viewport, width: view.width, height: view.height, path, horizontalOverflow: Boolean(overflow), pageHeight, screens: screens.length, truncated: plan.truncated })
        }
      }
    } finally {
      if (dbg.isAttached()) dbg.detach()
    }
    return { shots, consoleErrors }
  } finally {
    input.previews.release(prepared.url)
    if (!win.isDestroyed()) win.destroy()
  }
}
