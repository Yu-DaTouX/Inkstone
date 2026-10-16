/**
 * 快速提问窗口（v3 WP-25d）。
 *
 * 无边框浮动输入框：全局快捷键唤出，失焦隐藏，Esc 关闭。位置与主窗口协调，
 * 尺寸取设计规范 §13.3 的 560×160；缩放跟随主窗口，避免高分屏上小窗字太小。
 *
 * 这里只负责窗口本身（创建 / 摆放 / 显示 / 隐藏 / 销毁）；发送逻辑在
 * quick-ask-submit.ts，窗口状态在 aux-state.ts，Electron 之外的编排在
 * aux-controller.ts。
 */
import { BrowserWindow } from 'electron'
import { QUICK_ASK_SIZE, computeQuickAskBounds, type Rect } from './geometry'

export interface QuickAskWindowDeps {
  preloadPath: string
  /** 在窗口上加载渲染端入口（dev URL 或打包后的 html）。 */
  load(win: BrowserWindow): void
  /** 主窗口边界；没有主窗口时返回 undefined。 */
  anchorBounds(): Rect | undefined
  /** 给定边界落在哪个显示器的工作区。 */
  workArea(bounds: Rect): Rect
  /** 跟随主窗口的界面缩放（1 = 100%）。 */
  zoomFactor(): number
  /** 窗口因失焦 / 关闭按钮自己隐藏时通知控制器同步状态。 */
  onHide?(): void
}

export interface QuickAskWindow {
  show(): void
  hide(): void
  isVisible(): boolean
  browserWindow(): BrowserWindow | null
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
    backgroundColor: '#151515',
    webPreferences: {
      preload: deps.preloadPath,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  // 浮动层：高于普通窗口，但不抢系统级的焦点面板层。
  win.setAlwaysOnTop(true, 'pop-up-menu')

  const place = (): void => {
    const anchor = deps.anchorBounds()
    const area = deps.workArea(anchor ?? { x: 0, y: 0, width: 0, height: 0 })
    const bounds = computeQuickAskBounds({ ...(anchor ? { anchor } : {}), area, size: QUICK_ASK_SIZE })
    win.setBounds(bounds)
    const factor = deps.zoomFactor()
    if (Number.isFinite(factor) && factor > 0) win.webContents.setZoomFactor(factor)
  }

  // 点到别处就收起来：这是「随手问一句」的窗口，不应常驻屏幕。
  win.on('blur', () => {
    if (destroyed) return
    win.hide()
    deps.onHide?.()
  })

  // 关闭按钮 / Esc 都只隐藏，不销毁：下次唤出要秒开。
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
