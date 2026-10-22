import { BrowserWindow } from 'electron'
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
}

export interface PreviewShotsResult {
  shots: PreviewShot[]
  consoleErrors: string[]
  loadError?: string
}

const VIEWPORTS = [
  { viewport: 'desktop', width: 1280, height: 800 },
  { viewport: 'narrow', width: 390, height: 844 }
] as const

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
          const image = await within(win.webContents.capturePage(), 'capture')
          if (image.isEmpty()) throw new Error('capture_empty')
          const path = join(dir, `${scheme}-${view.viewport}.png`)
          await writeFile(path, image.toPNG())
          shots.push({ scheme, viewport: view.viewport, width: view.width, height: view.height, path, horizontalOverflow: Boolean(overflow) })
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
