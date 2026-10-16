/**
 * 迷你小窗（v3 WP-12）。
 *
 * 置顶的状态小窗（设计规范 §13.4，宽 320）：只列 AttentionService 汇总出来的
 * 注意项，点击回到主窗口对应会话。默认关闭，是否启用由设置决定；窗口本身不做
 * 失焦隐藏（它就是要一直挂着看进度），Esc 关闭键由渲染端发送 close。
 *
 * 高度随条目数增长，超过上限后在窗口内滚动；位置贴主窗口右上角。
 */
import { BrowserWindow } from 'electron'
import { MINI_SIZE, computeMiniBounds, type Rect } from './geometry'
import { miniWindowHeight } from './aux-state'

export interface MiniWindowDeps {
  preloadPath: string
  load(win: BrowserWindow): void
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
}

export interface MiniWindow {
  show(): void
  hide(): void
  isVisible(): boolean
  /** 条目数变化时重算高度与位置。 */
  resize(itemCount: number): void
  browserWindow(): BrowserWindow | null
  webContents(): Electron.WebContents | null
  send(channel: string, payload: unknown): void
  destroy(): void
}

export function createMiniWindow(deps: MiniWindowDeps): MiniWindow {
  let destroyed = false
  let itemCount = 0
  const win = new BrowserWindow({
    ...MINI_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#151515',
    webPreferences: {
      preload: deps.preloadPath,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')

  const place = (): void => {
    const size = { width: MINI_SIZE.width, height: miniWindowHeight(itemCount) }
    const anchor = deps.anchorBounds()
    const area = deps.workArea(anchor ?? { x: 0, y: 0, width: 0, height: 0 })
    win.setBounds(computeMiniBounds({ area, ...(anchor ? { anchor } : {}), size }))
    const factor = deps.zoomFactor()
    if (Number.isFinite(factor) && factor > 0) win.webContents.setZoomFactor(factor)
  }

  win.on('close', (event) => {
    if (destroyed) return
    event.preventDefault()
    win.hide()
  })

  deps.load(win)

  return {
    show() {
      if (destroyed) return
      place()
      win.showInactive()
    },
    hide() {
      if (!destroyed && win.isVisible()) win.hide()
    },
    isVisible: () => !destroyed && win.isVisible(),
    resize(nextCount) {
      if (destroyed) return
      itemCount = Math.max(0, nextCount)
      place()
    },
    browserWindow: () => (destroyed ? null : win),
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
