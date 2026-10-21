import { BrowserWindow, globalShortcut } from 'electron'
import { INITIAL_QUICK_ASK_STATE, quickAskReducer, type QuickAskWindowState } from './aux-state'
import { createQuickAskWindow, type QuickAskWindow } from './quick-ask-window'
import type { Rect } from './geometry'
import type {
  AuxLocale,
  AuxModelOption,
  AuxProjectOption,
  AuxSessionRef,
  QuickAskResult,
  QuickAskStateView,
  QuickAskSubmit
} from './aux-types'

export interface AuxHost {
  preloadPath(): string
  loadEntry(win: BrowserWindow, entry: 'quick-ask'): void
  locale(): AuxLocale
  anchorBounds(): Rect | undefined
  workArea(bounds: Rect): Rect
  zoomFactor(): number
  listProjects(): Promise<AuxProjectOption[]>
  listModels(): Promise<AuxModelOption[]>
  currentSession(): Promise<AuxSessionRef | null>
  submitQuickAsk(payload: QuickAskSubmit): Promise<QuickAskResult>
  openSession(target: AuxSessionRef): void
  showMainWindow(): void
  shortcut(): string | null
}

export interface AuxWindows {
  showQuickAsk(): void
  toggleQuickAsk(): void
  hideQuickAsk(): void
  quickAskState(): Promise<QuickAskStateView>
  submitQuickAsk(payload: QuickAskSubmit): Promise<QuickAskResult>
  registerShortcut(): boolean
  owns(contents: Electron.WebContents): boolean
  dispose(): void
}

export function createAuxWindows(host: AuxHost): AuxWindows {
  let quickAskState: QuickAskWindowState = INITIAL_QUICK_ASK_STATE
  let quickAsk: QuickAskWindow | null = null
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

  const pushQuickAsk = (payload: unknown): void => {
    quickAsk?.send('yan:aux:push', { ch: 'quick-ask', payload })
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

  return {
    showQuickAsk,
    toggleQuickAsk() {
      if (quickAsk?.isVisible()) hideQuickAsk()
      else showQuickAsk()
    },
    hideQuickAsk,
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
    owns(contents) {
      const quick = quickAsk?.webContents()
      if (quick && !quick.isDestroyed() && quick === contents) return true
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
      quickAsk = null
    }
  }
}
