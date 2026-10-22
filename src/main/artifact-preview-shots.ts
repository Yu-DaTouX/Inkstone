import { BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HtmlArtifactPreviewStore } from './html-artifact-preview-store'

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

export interface PreviewShotsResult {
  shots: PreviewShot[]
  consoleErrors: string[]
  loadError?: string
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

const SCHEMES = ['light', 'dark'] as const
const SETTLE_MS = 600
const STEP_TIMEOUT_MS = 15000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  const unique = offsets.filter((y, index) => index === 0 || y !== offsets[index - 1])
  return { offsets: unique, truncated: pageHeight > viewportHeight * MAX_SCREENS + SCREEN_SLACK }
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

export async function captureHtmlPreviewShots(input: {
  previews: HtmlArtifactPreviewStore
  htmlPath: string
  root: string
  outDir: string
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
  const dir = join(input.outDir, randomUUID())
  await mkdir(dir, { recursive: true })
  const shots: PreviewShot[] = []
  try {
    try {
      await within(win.loadURL(prepared.url), 'load')
    } catch (error) {
      return { shots, consoleErrors, loadError: error instanceof Error ? error.message : String(error) }
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
