/**
 * AttentionService（v3 WP-12）。
 *
 * 应用外的注意力投影：把 `runs-host` 的运行快照折成注意状态（等你确认 /
 * 失败 / 完成未读），驱动任务栏进度与覆盖图标、托盘图标提示与菜单。
 * 迁移自 `src/main/index.ts` 里原本内联的 `refreshTaskbar` / `trayImage` /
 * `createTray` / `refreshTrayMenu`，行为保持不变：Windows 任务栏进度条
 * （有运行）与覆盖图标（有等待），托盘菜单的显示砚 / 新建会话 / 运行中的
 * 会话 / 退出砚。
 *
 * 与 Electron 的边界：本模块**不 import Electron**，只接收窄端口，因此可以
 * 用假窗口 / 假托盘在 node 里直接回归（见 scripts/test-v3-attention.mjs）。
 * 真实 Tray / BrowserWindow / Menu 的构造留在 `src/main/index.ts`。
 *
 * 注意来源分两层：
 *   · 注册表（`deps.snapshot()`）—— 等你确认 / 失败未读 / 完成未读 / 停滞；
 *   · 宿主事实（`hostBusy` / `hostWaiting`）—— 终端、Agent Hub、批准中转这些
 *     尚未进入运行注册表的忙碌与等待，保留迁移前的判定，避免回归。
 */
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

/** 任务栏投影需要的最小窗口面（结构兼容 Electron.BrowserWindow）。 */
export interface AttentionWindowPort {
  id: number
  isDestroyed(): boolean
  setProgressBar(progress: number, options?: { mode: 'indeterminate' }): void
  setOverlayIcon(icon: unknown, description: string): void
  flashFrame(flag: boolean): void
}

/** 托盘投影需要的最小托盘面（结构兼容 Electron.Tray）。 */
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
  /** 运行注册表快照（只读；未就绪时由宿主返回空表）。 */
  snapshot(): { revision: number; runs: RunSnapshot[] }
  /** 终端的忙碌 / 等待、Agent Hub、子代理等尚未进注册表的宿主事实。 */
  hostBusy(): boolean
  hostWaiting(): boolean
  window(): AttentionWindowPort | undefined
  /** 当前系统主题下应使用的托盘字形（由宿主按 build/tray 资源挑选）。 */
  trayImage(): unknown
  createTray(image: unknown): AttentionTrayPort
  /**
   * 托盘动画素材（可选）：给了就启用 L12 柔和闪动，缺省保持迁移前的静态托盘。
   * 返回的是**预载好的内存帧集**；播放器不会再读盘或重建菜单。
   */
  trayAnimationAssets?(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
  /** 当前系统任务栏深浅；缺省按 on-light。 */
  trayTheme?(): TrayTheme
  /** 减少动态效果是否允许动画；缺省 false（未明确前保持静态）。 */
  motionAllowed?(): boolean
  /** 可注入时钟（测试用虚拟时钟）；缺省 setTimeout/Date.now。 */
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
  /** 创建托盘（幂等）；在启动时调用一次。 */
  ensureTray(): void
  hasTray(): boolean
  /** 重算注意投影并更新任务栏 + 托盘提示；force 用于主题切换后强制应用。 */
  refreshTaskbar(force?: boolean): void
  /** 重建托盘菜单。 */
  refreshMenu(): void
  /** 有运行在后台等你时闪烁任务栏。 */
  flash(): void
  /** 最近一次汇总（托盘提示 / 需要时给渲染端）。 */
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
  /* snapshot() 会 flush 待发增量，可能触发一次 'runs' 推送重入；用这个闸避免重复应用。 */
  let applying = false

  /*
   * 托盘柔和闪动播放器（可选）。只在宿主明确传入素材端口时创建；apply 走当前
   * tray 实例。按真实帧时长用单链 timer 驱动，状态/主题/减少动态变化立即重排。
   */
  const assetsPort = deps.trayAnimationAssets
  const player: TrayAnimationPlayer | null = assetsPort
    ? createTrayAnimationPlayer({
        assets: (state, theme) => assetsPort(state, theme),
        theme: () => deps.trayTheme?.() ?? 'on-light',
        apply: (image) => {
          try {
            tray?.setImage(image)
          } catch {
            /* 托盘已销毁的竞态忽略 */
          }
        },
        clock: deps.clock
      })
    : null

  /** 待用户操作 > 运行 > 空闲；failed/done 等终态不算「待确认」。 */
  const trayState = (busy: boolean, waiting: boolean): TrayAnimationState =>
    waiting ? 'waiting' : busy ? 'running' : 'idle'

  const zh = (): boolean => deps.language() !== 'en-US'

  const summarize = (): AttentionSummary => {
    try {
      lastSummary = summarizeAttention(deps.snapshot().runs)
    } catch {
      /* 快照不可用（注册表未就绪 / 抛错）时沿用上一次汇总，不让托盘刷新中断。 */
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
