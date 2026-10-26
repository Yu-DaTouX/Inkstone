import { BrowserWindow } from 'electron'
import { QUICK_ASK_SIZE, computeQuickAskBounds, type Rect } from './geometry'

export interface QuickAskWindowDeps {
  preloadPath: string
  load(win: BrowserWindow): void
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
  onHide?(): void
}

export interface QuickAskWindow {
  show(): void
  hide(): void
  isVisible(): boolean
  webContents(): Electron.WebContents | null
  send(channel: string, payload: unknown): void
  destroy(): void
}

export function createQuickAskWindow(deps: QuickAskWindowDeps): QuickAskWindow {
  let destroyed = false
  const win = new BrowserWindow({
    ...QUICK_ASK_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#171717',
    webPreferences: {
      preload: deps.preloadPath,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  win.setAlwaysOnTop(true, 'pop-up-menu')

  const place = (): void => {
    const anchor = deps.anchorBounds()
    const area = deps.workArea(anchor ?? { x: 0, y: 0, width: 0, height: 0 })
    const bounds = computeQuickAskBounds({ ...(anchor ? { anchor } : {}), area, size: QUICK_ASK_SIZE })
    win.setBounds(bounds)
    const factor = deps.zoomFactor()
    if (Number.isFinite(factor) && factor > 0) win.webContents.setZoomFactor(factor)
  }

  win.on('blur', () => {
    if (destroyed) return
    win.hide()
    deps.onHide?.()
  })

  win.on('close', (event) => {
    if (destroyed) return
    event.preventDefault()
    win.hide()
    deps.onHide?.()
  })

  deps.load(win)

  return {
    show() {
      if (destroyed) return
      place()
      win.show()
      win.focus()
    },
    hide() {
      if (!destroyed && win.isVisible()) win.hide()
    },
    isVisible: () => !destroyed && win.isVisible(),
    webContents: () => (destroyed ? null : win.webContents),
    send(channel, payload) {
      if (!destroyed && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      win.destroy()
    }
  }
}
