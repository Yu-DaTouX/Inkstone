import { BrowserWindow, globalShortcut } from 'electron'
import type { AttentionSummary } from '../attention/summary'
import { attentionItems } from './attention-items'
import {
  INITIAL_MINI_STATE,
  INITIAL_QUICK_ASK_STATE,
  miniReducer,
  quickAskReducer,
  type MiniWindowState,
  type QuickAskWindowState
} from './aux-state'
import { createMiniWindow, type MiniWindow } from './mini-window'
import { createQuickAskWindow, type QuickAskWindow } from './quick-ask-window'
import type { Rect } from './geometry'
import type {
  AuxLocale,
  AuxModelOption,
  AuxProjectOption,
  AuxSessionRef,
  MiniItem,
  MiniStateView,
  QuickAskResult,
  QuickAskStateView,
  QuickAskSubmit
} from './aux-types'

export interface AuxHost {
  preloadPath(): string
  loadEntry(win: BrowserWindow, entry: 'quick-ask' | 'mini'): void
  locale(): AuxLocale
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
  listProjects(): Promise<AuxProjectOption[]>
  listModels(): Promise<AuxModelOption[]>
  currentSession(): Promise<AuxSessionRef | null>
  attentionSummary(): AttentionSummary
  submitQuickAsk(payload: QuickAskSubmit): Promise<QuickAskResult>
  openSession(target: AuxSessionRef): void
  showMainWindow(): void
  shortcut(): string | null
  miniEnabled(): boolean
}

export interface AuxWindows {
  showQuickAsk(): void
  toggleQuickAsk(): void
  hideQuickAsk(): void
  isQuickAskVisible(): boolean
  quickAskState(): Promise<QuickAskStateView>
  submitQuickAsk(payload: QuickAskSubmit): Promise<QuickAskResult>
  showMini(): void
  hideMini(): void
  setMiniEnabled(enabled: boolean): void
  miniState(): MiniStateView
  openMiniItem(item: MiniItem): void
  notifyRuns(): void
  registerShortcut(): boolean
  hasShortcut(): boolean
  owns(contents: Electron.WebContents): boolean
  dispose(): void
}

export function createAuxWindows(host: AuxHost): AuxWindows {
  let quickAskState: QuickAskWindowState = INITIAL_QUICK_ASK_STATE
  let miniState: MiniWindowState = { ...INITIAL_MINI_STATE, enabled: host.miniEnabled() }
  let quickAsk: QuickAskWindow | null = null
  let mini: MiniWindow | null = null
  let shortcutRegistered = false

  const quickAskView = async (): Promise<QuickAskStateView> => {
    const [session, projects, models] = await Promise.all([
      host.currentSession(),
      host.listProjects(),
      host.listModels()
    ])
    return {
      locale: host.locale(),
      projects,
      models,
      currentSession: session,
      defaultTarget: session ? 'current' : 'new',
      defaultProjectId: session?.projectId ?? null,
      defaultModelId: null,
      accelerator: host.shortcut() ?? ''
    }
  }

  const miniView = (): MiniStateView => ({
    locale: host.locale(),
    enabled: miniState.enabled,
    items: miniState.items
  })

  const pushQuickAsk = (payload: unknown): void => {
    quickAsk?.send('yan:aux:push', { ch: 'quick-ask', payload })
  }

  const pushMini = (): void => {
    mini?.send('yan:aux:push', { ch: 'mini', payload: miniView() })
  }

  const ensureQuickAsk = (): QuickAskWindow => {
    if (quickAsk) return quickAsk
    quickAsk = createQuickAskWindow({
      preloadPath: host.preloadPath(),
      load: (win) => host.loadEntry(win, 'quick-ask'),
      anchorBounds: () => host.anchorBounds(),
      workArea: (bounds) => host.workArea(bounds),
      zoomFactor: () => host.zoomFactor(),
      onHide: () => {
        quickAskState = quickAskReducer(quickAskState, { type: 'hide' })
      }
    })
    return quickAsk
  }

  const ensureMini = (): MiniWindow => {
    if (mini) return mini
    mini = createMiniWindow({
      preloadPath: host.preloadPath(),
      load: (win) => host.loadEntry(win, 'mini'),
      anchorBounds: () => host.anchorBounds(),
      workArea: (bounds) => host.workArea(bounds),
      zoomFactor: () => host.zoomFactor()
    })
    mini.resize(miniState.items.length)
    return mini
  }

  const showQuickAsk = (): void => {
    quickAskState = quickAskReducer(quickAskState, { type: 'show' })
    ensureQuickAsk().show()
    pushQuickAsk({ kind: 'show' })
  }

  const hideQuickAsk = (): void => {
    if (!quickAskState.visible && !quickAskState.submitting) return
    quickAskState = quickAskReducer(quickAskState, { type: 'hide' })
    quickAsk?.hide()
  }

  const setMiniEnabled = (enabled: boolean): void => {
    miniState = miniReducer(miniState, { type: 'set-enabled', enabled })
    if (enabled) {
      ensureMini().show()
      pushMini()
      notifyRuns()
    } else {
      mini?.hide()
    }
  }

  const notifyRuns = (): void => {
    miniState = miniReducer(miniState, { type: 'set-items', items: attentionItems(host.attentionSummary()) })
    if (mini && miniState.enabled) {
      mini.resize(miniState.items.length)
      pushMini()
    }
  }

  return {
    showQuickAsk,
    toggleQuickAsk() {
      if (quickAsk?.isVisible()) hideQuickAsk()
      else showQuickAsk()
    },
    hideQuickAsk,
    isQuickAskVisible: () => quickAsk?.isVisible() ?? false,
    quickAskState: quickAskView,
    async submitQuickAsk(payload) {
      if (quickAskState.submitting) return { ok: false, code: 'unavailable' }
      quickAskState = quickAskReducer(quickAskState, { type: 'submit-start' })
      pushQuickAsk({ kind: 'submitting' })
      let result: QuickAskResult
      try {
        result = await host.submitQuickAsk(payload)
      } catch (error) {
        result = { ok: false, code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok) {
        quickAskState = quickAskReducer(quickAskState, { type: 'submit-ok' })
        quickAsk?.hide()
        if (result.sessionId || result.sessionPath || payload.expand) {
          host.showMainWindow()
          host.openSession({
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
            ...(payload.projectId ? { projectId: payload.projectId } : {})
          })
        }
      } else {
        quickAskState = quickAskReducer(quickAskState, {
          type: 'submit-error',
          code: result.code ?? 'unavailable',
          ...(result.message ? { message: result.message } : {})
        })
      }
      pushQuickAsk({ kind: 'result', result })
      return result
    },
    showMini() {
      if (!miniState.enabled) setMiniEnabled(true)
      else {
        miniState = miniReducer(miniState, { type: 'show' })
        ensureMini().show()
        pushMini()
      }
    },
    hideMini() {
      miniState = miniReducer(miniState, { type: 'hide' })
      mini?.hide()
    },
    setMiniEnabled,
    miniState: miniView,
    openMiniItem(item) {
      host.showMainWindow()
      host.openSession({
        sessionId: item.sessionId,
        ...(item.sessionPath ? { sessionPath: item.sessionPath } : {}),
        ...(item.projectId ? { projectId: item.projectId } : {})
      })
    },
    notifyRuns,
    registerShortcut() {
      const accelerator = host.shortcut()
      if (!accelerator || shortcutRegistered) return shortcutRegistered
      try {
        shortcutRegistered = globalShortcut.register(accelerator, () => {
          if (quickAsk?.isVisible()) hideQuickAsk()
          else showQuickAsk()
        })
      } catch {
        shortcutRegistered = false
      }
      return shortcutRegistered
    },
    hasShortcut: () => shortcutRegistered,
    owns(contents) {
      const quick = quickAsk?.webContents()
      if (quick && !quick.isDestroyed() && quick === contents) return true
      const small = mini?.webContents()
      if (small && !small.isDestroyed() && small === contents) return true
      return false
    },
    dispose() {
      if (shortcutRegistered) {
        try {
          const accelerator = host.shortcut()
          if (accelerator) globalShortcut.unregister(accelerator)
        } catch {
        }
        shortcutRegistered = false
      }
      quickAsk?.destroy()
      mini?.destroy()
      quickAsk = null
      mini = null
    }
  }
}
