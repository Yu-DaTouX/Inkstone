import type { RunSnapshot } from '../../shared/runs'
import { summarizeAttention, type AttentionSummary } from './summary'
import {
  createTrayAnimationPlayer,
  type TrayAnimationClock,
  type TrayAnimationPlayer,
  type TrayAnimationState,
  type TrayFrameSet,
  type TrayTheme
} from './tray-animation'
import {
  buildAttentionMenu,
  type AttentionMenuNode,
  type TraySelectTarget,
  type TraySessionStatus
} from './tray-menu'

export interface AttentionWindowPort {
  id: number
  isDestroyed(): boolean
  setProgressBar(progress: number, options?: { mode: 'indeterminate' }): void
  setOverlayIcon(icon: unknown, description: string): void
  flashFrame(flag: boolean): void
}

export interface AttentionTrayPort {
  setImage(image: unknown): void
  setToolTip(text: string): void
  setContextMenu(nodes: AttentionMenuNode[]): void
  on(event: 'click' | 'double-click', listener: () => void): void
  setTitle?(title: string): void
  destroy(): void
}

export interface AttentionServiceDeps {
  platform: NodeJS.Platform
  snapshot(): { revision: number; runs: RunSnapshot[] }
  hostBusy(): boolean
  hostWaiting(): boolean
  window(): AttentionWindowPort | undefined
  trayImage(): unknown
  createTray(image: unknown): AttentionTrayPort
  trayAnimationAssets?(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
  trayTheme?(): TrayTheme
  motionAllowed?(): boolean
  clock?: TrayAnimationClock
  language(): string | undefined
  statuses(): TraySessionStatus[]
  showMainWindow(): void
  newSession(): void
  selectSession(target: TraySelectTarget): void
  quit(): void
  onThemeChange(listener: () => void): () => void
}

export interface AttentionService {
  ensureTray(): void
  hasTray(): boolean
  refreshTaskbar(force?: boolean): void
  refreshMenu(): void
  flash(): void
  summary(): AttentionSummary
  dispose(): void
}

interface TaskbarProjection {
  windowId: number
  busy: boolean
  waiting: boolean
}

const EMPTY_SUMMARY = summarizeAttention([])

export function createAttentionService(deps: AttentionServiceDeps): AttentionService {
  let tray: AttentionTrayPort | null = null
  let unsubscribeTheme: (() => void) | null = null
  let projection: TaskbarProjection | undefined
  let lastSummary: AttentionSummary = EMPTY_SUMMARY
  let applying = false

  const assetsPort = deps.trayAnimationAssets
  const player: TrayAnimationPlayer | null = assetsPort
    ? createTrayAnimationPlayer({
        assets: (state, theme) => assetsPort(state, theme),
        theme: () => deps.trayTheme?.() ?? 'on-light',
        apply: (image) => {
          try {
            tray?.setImage(image)
          } catch {
          }
        },
        clock: deps.clock
      })
    : null

  const trayState = (busy: boolean, waiting: boolean): TrayAnimationState =>
    waiting ? 'waiting' : busy ? 'running' : 'idle'

  const zh = (): boolean => deps.language() !== 'en-US'

  const summarize = (): AttentionSummary => {
    try {
      lastSummary = summarizeAttention(deps.snapshot().runs)
    } catch {
    }
    return lastSummary
  }

  const safe = (fn: () => boolean): boolean => {
    try {
      return fn()
    } catch {
      return false
    }
  }

  const tooltip = (summary: AttentionSummary): string => {
    const localized = zh()
    if (summary.attentionCount > 0) {
      return localized
        ? `砚 · Yan · ${summary.attentionCount} 项待处理`
        : `Yan · ${summary.attentionCount} need attention`
    }
    if (summary.busy || safe(deps.hostBusy)) {
      return localized ? '砚 · Yan · 运行中' : 'Yan · running'
    }
    return '砚 · Yan'
  }

  const applyTaskbar = (force: boolean, busy: boolean, waiting: boolean): void => {
    const win = deps.window()
    if (deps.platform !== 'win32' || !win || win.isDestroyed()) return
    const previous = projection && projection.windowId === win.id ? projection : undefined
    if (force || previous?.busy !== busy) {
      win.setProgressBar(busy ? 2 : -1, busy ? { mode: 'indeterminate' as const } : undefined)
    }
    if (force || previous?.waiting !== waiting) {
      win.setOverlayIcon(waiting ? deps.trayImage() : null, waiting ? '有任务等待你的处理' : '')
    }
    projection = { windowId: win.id, busy, waiting }
  }

  const refreshTaskbar = (force = false): void => {
    if (applying) return
    applying = true
    try {
      const summary = summarize()
      const busy = summary.busy || safe(deps.hostBusy)
      const waiting = summary.waiting || safe(deps.hostWaiting)
      applyTaskbar(force, busy, waiting)
      if (player) {
        player.setMotionAllowed(deps.motionAllowed?.() ?? false)
        player.setState(trayState(busy, waiting))
      }
      if (tray) {
        tray.setToolTip(tooltip(summary))
        if (deps.platform === 'darwin' && tray.setTitle) {
          tray.setTitle(summary.attentionCount > 0 ? String(summary.attentionCount) : '')
        }
      }
    } finally {
      applying = false
    }
  }

  const refreshMenu = (): void => {
    if (!tray) return
    const summary = summarize()
    tray.setContextMenu(
      buildAttentionMenu({
        zh: zh(),
        statuses: deps.statuses(),
        summary,
        callbacks: {
          show: deps.showMainWindow,
          newSession: deps.newSession,
          selectSession: deps.selectSession,
          quit: deps.quit
        }
      })
    )
  }

  const ensureTray = (): void => {
    if (tray) return
    tray = deps.createTray(deps.trayImage())
    tray.on('click', deps.showMainWindow)
    tray.on('double-click', deps.showMainWindow)
    if (!unsubscribeTheme) unsubscribeTheme = deps.onThemeChange(() => {
      if (player) player.refresh()
      else tray?.setImage(deps.trayImage())
      refreshTaskbar(true)
    })
    refreshTaskbar(true)
    refreshMenu()
  }

  return {
    ensureTray,
    hasTray: () => tray !== null,
    refreshTaskbar,
    refreshMenu,
    flash() {
      const win = deps.window()
      if (win && !win.isDestroyed()) win.flashFrame(true)
    },
    summary: () => lastSummary,
    dispose() {
      unsubscribeTheme?.()
      unsubscribeTheme = null
      player?.dispose()
      tray?.destroy()
      tray = null
      projection = undefined
    }
  }
}
