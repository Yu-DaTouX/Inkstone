import '../design/index.css'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react'
import { FocusScope } from 'react-aria'
import { showToast, Splitter, useScrollbarReveal } from '../ui'
import { useTranscriptViews } from '../state/transcript-view'
import { transcriptViewText } from '../features/session/transcript-view-text'
import { useI18n } from '../i18n'
import { useStore } from '../state/store'
import { useRunnerVisibility } from '../lib/use-runner-visibility'
import { useHoverDelay } from '../lib/use-hover-delay'
import { sessionViewIdentity, viewMatchesProjectedSession } from '../features/session/view-state'
import { isModalOpen } from '../lib/modalLayer'
import { dismissBootSplash } from '../lib/boot-splash'
import { useUiV3, useV3RouteSync } from '../state/ui-v3'
import { startRunSync } from '../state/runs-v3'
import { useCurrentRunsSeen } from '../state/use-current-runs-seen'
import type { RunSnapshot } from '../../../shared/runs'
import { Sidebar } from '../features/sidebar/Sidebar'
import { SessionDragLayer } from '../features/sidebar/SessionDragLayer'
import { SIDEBAR_DRAG_COLLAPSE, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_STEP, SIDEBAR_WIDTH_STEP_LARGE, readSidebarWidth, sidebarMaxForWindow, shouldAutoCollapseSidebar } from '../features/sidebar/sidebar-layout'
import { ChatMain } from './ChatMain'
import { CommandPalette } from '../features/commands/CommandPalette'
import { ShortcutSheet } from '../features/commands/ShortcutSheet'
import { SessionSwitcher, useSessionSwitcher } from '../features/commands/SessionSwitcher'
import { resolveV3Shortcut, shortcutOverridesFromSettings } from './shortcuts'
import { runPrimaryProjectScript } from '../features/scripts/run-project-script'
import { NoticeBridge } from './NoticeBridge'
import { PeerApprovalDialog } from './PeerApprovalDialog'
import { BrowserSiteAskDialog } from '../features/browser/SiteAskDialog'
import { SettingsPanelV3 } from './SettingsPanelV3'
import { openSettingsDialog } from '../features/settings/root/deep-link'
import { RunAttentionToasts } from '../patterns/RunAttentionToasts'
import { Header } from './Header'
import { applyAppearanceV3 } from '../lib/appearance-v3'
import { ConnBanner } from './ConnBanner'
import { OnboardingWizard, markOnboarded, shouldAutoWizard } from '../features/onboarding'
import { NativeSessionSurfaces } from '../features/session/native'
import { V3ErrorBoundary } from './ErrorBoundary'
import { RightPanelT3, requestNewPanelMenu } from '../features/workbench/RightPanelT3'
import { OverviewPane } from '../features/workbench/OverviewPane'
import { WORKBENCH_PANES } from '../features/workbench/panes'
import { filesClaimsQuickOpen } from '../features/files/FilesPane'
import { useWorkspaceOwner } from '../features/workbench/use-owner'
import { useChatFilePreview } from '../features/preview/use-chat-file-preview'
import { useLiveHtmlFollow } from '../features/preview/live-html'
import { useWorkspaceHasChanges } from '../features/workbench/use-workspace-branch'
import { activateWorkspaceOwner, captureActivationTarget } from '../features/workbench/activation'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId } from '../features/workbench/types'
import { usePruneSubagentSurfaces } from '../features/workbench/use-subagent-surfaces'
import { useTerminalRunning } from '../features/terminal/use-terminal-running'
import { PANEL_WIDTH_MIN, clampPanelWidth, currentPanelEntry, panelRoom, toolSurface, useRightPanel, useRightPanelEntry, type PanelToolKind } from '../state/right-panel'
import { reopenLastClosed } from '../state/right-panel-reopen'
import { railText } from '../features/workbench/rail-text'
import { LANE_GAP, MESSAGE_MIN_WIDTH, TILES_WIDTH_DEFAULT, TILES_WIDTH_MAX, TILES_WIDTH_MIN, TILES_WIDTH_STEP, clampTilesWidth, readTilesWidth, tilesWidthRoom, writeTilesWidth } from './tiles-width'
import { createFrameBatch } from './frame-batch'
import './ShellV3.css'

let bootstrapStarted = false

const UsagePage = lazy(() => import('../features/usage/UsagePage').then((m) => ({ default: m.UsagePage })))
const CollabPage = lazy(() => import('../features/collab').then((m) => ({ default: m.CollabPage })))
const ScheduleTasksPage = lazy(() => import('../features/schedule').then((m) => ({ default: m.ScheduleTasksPage })))
const ArtifactLibraryPage = lazy(() => import('../features/artifacts/ArtifactLibraryPage').then((m) => ({ default: m.ArtifactLibraryPage })))

const CHAT_MIN_WIDTH_PX = 420
const SHEET_BELOW_PX = CHAT_MIN_WIDTH_PX + PANEL_WIDTH_MIN

export default function ShellV3(): ReactElement {
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth(localStorage))
  const [sidebarPreview, setSidebarPreview] = useState(false)
  useScrollbarReveal()
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)) } catch { } }, 150)
    return () => clearTimeout(timer)
  }, [sidebarWidth])
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const [sidebarDragHidden, setSidebarDragHidden] = useState(false)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const [sidebarCompact, setSidebarCompact] = useState(() => shouldAutoCollapseSidebar(window.innerWidth, sidebarWidth))
  useEffect(() => {
    let last: boolean | null = null
    const apply = (): void => {
      const width = window.innerWidth
      const next = shouldAutoCollapseSidebar(width, sidebarWidthRef.current)
      setWindowWidth(width)
      setSidebarCompact(next)
      if (next === last) return
      last = next
      useUiV3.getState().setSidebarOpen(!next)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const sidebarMax = sidebarMaxForWindow(windowWidth)
  const [tilesWidth, setTilesWidth] = useState(() => readTilesWidth(localStorage))
  const tilesFrame = useRef(0)
  const resizeTiles = useCallback((next: number) => {
    cancelAnimationFrame(tilesFrame.current)
    tilesFrame.current = requestAnimationFrame(() => setTilesWidth(clampTilesWidth(next)))
  }, [])
  useEffect(() => () => cancelAnimationFrame(tilesFrame.current), [])
  useEffect(() => {
    const timer = setTimeout(() => writeTilesWidth(localStorage, tilesWidth), 150)
    return () => clearTimeout(timer)
  }, [tilesWidth])
  const bodyRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(1000)
  const [measuredChatWidth, setMeasuredChatWidth] = useState(0)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const updateSize = (): void => {
      setBodyWidth(body.clientWidth)
      body.style.setProperty('--sidebar-offset', `${Math.max(0, body.getBoundingClientRect().left)}px`)
    }
    const measure = createFrameBatch<void>(updateSize)
    const observer = new ResizeObserver(() => measure.schedule())
    observer.observe(body)
    updateSize()
    return () => {
      observer.disconnect()
      measure.cancel()
    }
  }, [])
  useV3RouteSync()
  const { lang, setLang } = useI18n()

  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const applyPush = useStore((s) => s.applyPush)
  const bootstrap = useStore((s) => s.bootstrap)
  const startConnWatch = useStore((s) => s.startConnWatch)
  const nativeSessionPanel = useStore((s) => s.nativeSessionPanel)

  const route = useUiV3((s) => s.route)
  const sidebarOpen = useUiV3((s) => s.sidebarOpen)
  const panelEntry = useRightPanelEntry()
  const panelStoredWidth = useRightPanel((s) => s.width)
  const hasMessages = useStore((s) => s.messages.length > 0)
  const sessionBarOn = useStore((s) => s.settings?.workspaceTiles !== false)
  const panelOpen = route.name === 'chat' && panelEntry.open
  const [sessionBarWidth] = useState(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-tiles')) || 300)
  const showSidebarPreview = useCallback(() => { if (!useUiV3.getState().sidebarOpen) setSidebarPreview(true) }, [])
  const reveal = useHoverDelay(120, showSidebarPreview)
  useEffect(() => { if (sidebarOpen) { reveal.cancel(); setSidebarPreview(false) } }, [sidebarOpen, reveal])
  const [previewPhase, setPreviewPhase] = useState<'off' | 'leaving' | 'reset'>('off')
  const previewWasOn = useRef(false)
  useLayoutEffect(() => {
    const was = previewWasOn.current
    previewWasOn.current = sidebarPreview
    if (sidebarPreview || !was || useUiV3.getState().sidebarOpen) { setPreviewPhase('off'); return }
    setPreviewPhase('leaving')
    const leaveMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-base')) || 0
    let frame = 0
    const timer = window.setTimeout(() => {
      setPreviewPhase('reset')
      frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => setPreviewPhase('off')) })
    }, leaveMs)
    return () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame) }
  }, [sidebarPreview])
  useEffect(() => {
    if (!sidebarPreview) return
    let timer: number | null = null
    const clear = (): void => { if (timer !== null) window.clearTimeout(timer); timer = null }
    const scheduleHide = (): void => { if (timer === null) timer = window.setTimeout(() => setSidebarPreview(false), 350) }
    const onMove = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.v3-side, [data-testid="v3-rail-toggle"], [data-testid="v3-sidebar-reveal"], [role="menu"], [role="dialog"]')) { clear(); return }
      scheduleHide()
    }
    const onOut = (event: PointerEvent): void => { if (!event.relatedTarget) scheduleHide() }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerout', onOut)
    window.addEventListener('blur', scheduleHide)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerout', onOut)
      window.removeEventListener('blur', scheduleHide)
      clear()
    }
  }, [sidebarPreview])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false)
  const sessionSwitcher = useSessionSwitcher()
  const stepSessionSwitcher = sessionSwitcher.step
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const onboardDecided = useRef(false)
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia('(max-width: 899px)').matches)

  const owner = useWorkspaceOwner()
  useChatFilePreview(owner.key)
  useLiveHtmlFollow(owner.key)
  const sidebarReserves = sidebarOpen && !sidebarCompact
  const rowWidth = Math.max(0, windowWidth - (sidebarReserves ? sidebarWidth + 1 : 0))
  const panelMode: 'inline' | 'sheet' = rowWidth > 0 && rowWidth < SHEET_BELOW_PX ? 'sheet' : 'inline'
  const panelRoomWidth = panelRoom(windowWidth, rowWidth, CHAT_MIN_WIDTH_PX)
  const panelMaximized = panelOpen && panelMode === 'inline' && panelEntry.maximized
  const liveSessionId = useStore((s) => s.session?.sessionId ?? null)
  useEffect(() => {
    useRightPanel.getState().load(liveSessionId)
  }, [liveSessionId])

  useEffect(() => {
    const off = window.yan.onPush(applyPush)
    if (!bootstrapStarted) {
      bootstrapStarted = true
      void bootstrap()
    }
    startConnWatch()
    return off
  }, [applyPush, bootstrap, startConnWatch])

  useEffect(() => startRunSync(), [])
  useCurrentRunsSeen()

  useEffect(() => {
    if (!settings) return
    const theme = settings.theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('yan.theme', theme)
    } catch {
    }
  }, [settings])

  const appearanceKey = settings
    ? JSON.stringify([settings.density, settings.fontSizeUi, settings.fontUi, settings.fontUiCustom, settings.fontCode, settings.fontCodeCustom, settings.reduceMotion, settings.streamWidth])
    : null
  useEffect(() => {
    const current = useStore.getState().settings
    if (appearanceKey === null || !current) return
    applyAppearanceV3(document.documentElement, current)
  }, [appearanceKey])

  useEffect(() => {
    if (!settings) return
    if (settings.lang !== lang) setLang(settings.lang)
  }, [settings, lang, setLang])

  useEffect(() => {
    if (onboardDecided.current) return
    if (!settings) return
    onboardDecided.current = true
    useStore.getState().checkToolchainNotice()
    if (window.yan.isProbe) return
    if (shouldAutoWizard()) setOnboardingOpen(true)
  }, [settings])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)')
    const apply = (): void => setNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const visibleSessions = useMemo(() => {
    const sessionId = peekedSessionId ?? (peekedPath ? undefined : session?.sessionId || undefined)
    const path = peekedPath ?? (peekedSessionId ? undefined : session?.sessionFile || undefined)
    return sessionId || path ? [{ sessionId, path }] : []
  }, [peekedSessionId, peekedPath, session?.sessionId, session?.sessionFile])
  useRunnerVisibility(visibleSessions)
  usePruneSubagentSurfaces()
  useLayoutEffect(() => {
    if (route.name !== 'chat') return
    const chat = chatRef.current
    if (!chat) return
    const measure = createFrameBatch<void>(() => setMeasuredChatWidth(chat.clientWidth))
    setMeasuredChatWidth(chat.clientWidth)
    const observer = new ResizeObserver(() => measure.schedule())
    observer.observe(chat)
    return () => {
      observer.disconnect()
      measure.cancel()
    }
  }, [route.name])
  const chatWidth = route.name === 'chat' ? measuredChatWidth : bodyWidth
  const toastInset = panelOpen && panelMode === 'inline' && !panelMaximized ? Math.max(0, clampPanelWidth(panelStoredWidth, panelRoomWidth)) : 0
  useEffect(() => {
    document.documentElement.style.setProperty('--toast-inset-right', `${toastInset}px`)
  }, [toastInset])
  const sessionBarFits = chatWidth - (sessionBarWidth + LANE_GAP) >= MESSAGE_MIN_WIDTH
  const sessionBarWanted = route.name === 'chat' && hasMessages && sessionBarOn && !panelMaximized
  const sessionBarShown = sessionBarWanted && sessionBarFits
  const tilesRoom = tilesWidthRoom(chatWidth, LANE_GAP, MESSAGE_MIN_WIDTH)
  const shownTilesWidth = clampTilesWidth(tilesWidth, tilesRoom)
  const tilesMaxShown = clampTilesWidth(TILES_WIDTH_MAX, tilesRoom)
  const tilesAxis = TILES_WIDTH_MAX + TILES_WIDTH_MIN

  useEffect(() => {
    if (!settings) return
    const settled = conn === 'exited' || conn === 'error' || (conn === 'ready' && !!session)
    if (!settled) return
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => dismissBootSplash())
    })
    return () => cancelAnimationFrame(id)
  }, [settings, conn, session])

  useEffect(() => {
    const openSearch = (): void => useUiV3.getState().setSidebarOpen(true)
    window.addEventListener('yan-v3-focus-search', openSearch)
    return () => window.removeEventListener('yan-v3-focus-search', openSearch)
  }, [])

  const [settledBarOn, setSettledBarOn] = useState(sessionBarOn)
  useEffect(() => {
    if (settledBarOn === sessionBarOn) return
    const timer = window.setTimeout(() => setSettledBarOn(sessionBarOn), 400)
    return () => window.clearTimeout(timer)
  }, [sessionBarOn, settledBarOn])

  const toggleSessionBar = (): void => {
    void useStore.getState().patchSettings({ workspaceTiles: !sessionBarOn }).catch(() => undefined)
  }

  const requestActivation = (_tab: WorkbenchTabId): Promise<boolean> => activateWorkspaceOwner(captureActivationTarget())

  const openPanes = useMemo(
    () => new Set<WorkbenchTabId>(panelOpen ? panelEntry.surfaces.flatMap((item) => ((WORKBENCH_TABS as readonly string[]).includes(item.kind) ? [item.kind as WorkbenchTabId] : [])) : []),
    [panelOpen, panelEntry.surfaces]
  )
  const activePaneKind = panelOpen ? panelEntry.surfaces.find((item) => item.id === panelEntry.active)?.kind ?? null : null
  const activePane = activePaneKind === 'file' ? 'files' : activePaneKind
  const changesDirty = useWorkspaceHasChanges(owner.cwd || null, route.name === 'chat')
  const terminalRunning = useTerminalRunning(owner.key || null, route.name === 'chat')

  const openWorkspaceTab = useCallback((tab: WorkbenchTabId | PanelToolKind): Promise<boolean> => {
    useUiV3.getState().navigate({ name: 'chat' })
    const surface = toolSurface(tab)
    useRightPanel.getState().open(surface)
    if (!WORKBENCH_ACTIVE_TABS.has(surface.kind)) return Promise.resolve(true)
    return activateWorkspaceOwner(captureActivationTarget())
  }, [])

  const togglePane = (tab: WorkbenchTabId): void => {
    const entry = currentPanelEntry()
    const id = toolSurface(tab).id
    if (panelOpen && entry.surfaces.some((item) => item.id === id)) {
      if (entry.active === id) useRightPanel.getState().close(id)
      else useRightPanel.getState().activate(id)
      return
    }
    void openWorkspaceTab(tab)
  }

  useEffect(() => {
    if (nativeSessionPanel?.mode !== 'tree') return
    void openWorkspaceTab('branch')
    useStore.getState().closeNativeSessionPanel()
  }, [nativeSessionPanel, openWorkspaceTab])

  const toggleWorkspace = useCallback((): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    const entry = currentPanelEntry()
    if (entry.open) {
      useRightPanel.getState().setOpen(false)
      return
    }
    useRightPanel.getState().setOpen(true)
    const active = entry.surfaces.find((item) => item.id === entry.active)
    if (active && WORKBENCH_ACTIVE_TABS.has(active.kind)) void activateWorkspaceOwner(captureActivationTarget())
  }, [])

  useEffect(() => {
    const off = window.yan.onHotkey((action) => {
      const store = useStore.getState()
      if (action === 'cycleModel') {
        if (!filesClaimsQuickOpen()) void store.cycleModel()
      } else if (action === 'cycleModelBack') void store.cycleModelBack()
      else void store.cycleThinking()
    })
    return off
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || paletteOpen || isModalOpen()) return
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const shortcut = resolveV3Shortcut({
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        composing: event.isComposing,
        repeat: event.repeat,
        altGraph: typeof event.getModifierState === 'function' ? event.getModifierState('AltGraph') : false,
        inTerminal: !!target?.closest?.('.xterm'),
        editing: typing
      }, shortcutOverridesFromSettings(useStore.getState().settings))
      if (shortcut) {
        const ui = useUiV3.getState()
        switch (shortcut) {
          case 'commandPalette':
            event.preventDefault()
            setPaletteOpen(true)
            return
          case 'newSession':
            event.preventDefault()
            ui.navigate({ name: 'chat' })
            void useStore.getState().newSession({ scope: 'global' })
            return
          case 'switchSessionNext':
          case 'switchSessionPrevious':
            if (stepSessionSwitcher(shortcut, event)) event.preventDefault()
            return
          case 'toggleSidebar':
            event.preventDefault()
            ui.toggleSidebar()
            return
          case 'toggleWorkspace':
            event.preventDefault()
            toggleWorkspace()
            return
          case 'openSettings':
            event.preventDefault()
            openSettingsDialog()
            return
          case 'shortcutSheet':
            event.preventDefault()
            setShortcutSheetOpen(true)
            return
          case 'goBack':
            event.preventDefault()
            ui.goBack()
            return
          case 'focusComposer':
            event.preventDefault()
            useStore.getState().requestComposerFocus({})
            return
          case 'copyLastReply':
            event.preventDefault()
            void useStore.getState().copyLastReply()
            return
          case 'stopRun': {
            const s = useStore.getState()
            const view = sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
            const running = viewMatchesProjectedSession(view, s.session) && (!!s.session?.isAgentRunning || !!s.session?.isStreaming)
            event.preventDefault()
            if (running) void s.abort()
            return
          }
          case 'openTerminal':
            event.preventDefault()
            void openWorkspaceTab('terminal')
            return
          case 'runProjectScript':
            event.preventDefault()
            void runPrimaryProjectScript()
            return
          case 'cycleTranscriptView': {
            if (ui.route.name !== 'chat') return
            event.preventDefault()
            const s = useStore.getState()
            const view = sessionViewIdentity({ peekedSessionId: s.peekedSessionId, peekedPath: s.peekedPath, session: s.session })
            const text = transcriptViewText(lang)
            showToast(text.switched(text.views[useTranscriptViews.getState().cycle(view.sessionId)]), { timeout: 1800 })
            return
          }
          case 'workspaceTab1':
          case 'workspaceTab2':
          case 'workspaceTab3':
          case 'workspaceTab4':
          case 'workspaceTab5':
          case 'workspaceTab6': {
            event.preventDefault()
            const tab = WORKBENCH_TABS[Number(shortcut.slice('workspaceTab'.length)) - 1]
            if (tab) void openWorkspaceTab(tab)
            return
          }
          case 'workspaceClosePane': {
            const entry = currentPanelEntry()
            if (useUiV3.getState().route.name !== 'chat' || !entry.open || !entry.active) return
            event.preventDefault()
            useRightPanel.getState().close(entry.active)
            return
          }
          case 'workspaceNewPanel': {
            if (useUiV3.getState().route.name !== 'chat') return
            event.preventDefault()
            if (!currentPanelEntry().open) useRightPanel.getState().setOpen(true)
            requestNewPanelMenu()
            return
          }
          case 'workspaceReopenPanel': {
            if (useUiV3.getState().route.name !== 'chat') return
            event.preventDefault()
            void reopenLastClosed()
            return
          }
          case 'workspaceToggleMaximize': {
            const entry = currentPanelEntry()
            if (useUiV3.getState().route.name !== 'chat' || !entry.open || !entry.surfaces.length) return
            event.preventDefault()
            useRightPanel.getState().setMaximized(!entry.maximized)
            return
          }
          default:
            break
        }
      }
      if (event.key === 'Escape' && !typing) {
        const ui = useUiV3.getState()
        if (currentPanelEntry().maximized && currentPanelEntry().open) useRightPanel.getState().setMaximized(false)
        else if (ui.route.name !== 'chat') ui.goBack()
        else if (sidebarCompact && ui.sidebarOpen) ui.setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebarCompact, paletteOpen, panelMode, toggleWorkspace, openWorkspaceTab, lang, stepSessionSwitcher])

  const drawerOpen = sidebarCompact && sidebarOpen
  const drawerWasOpen = useRef(false)
  useEffect(() => {
    const was = drawerWasOpen.current
    drawerWasOpen.current = drawerOpen
    if (drawerOpen === was) return
    if (drawerOpen) {
      document.querySelector<HTMLElement>('.v3-side')?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true })
      return
    }
    if (!sidebarCompact) return
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.v3-side')) return
    document.querySelector<HTMLElement>('[data-testid="v3-rail-toggle"]')?.focus({ preventScroll: true })
  }, [drawerOpen, sidebarCompact])

  const sidebarActions = useMemo(() => ({
    onClose: () => { setSidebarPreview(false); useUiV3.getState().setSidebarOpen(false) },
    onPin: () => useUiV3.getState().setSidebarOpen(true),
    onSchedule: () => useUiV3.getState().navigate({ name: 'schedule' }),
    onCollab: () => useUiV3.getState().navigate({ name: 'collab' }),
    onArtifacts: () => useUiV3.getState().navigate({ name: 'artifacts' }),
    onSettings: () => openSettingsDialog(),
    onSearch: () => setPaletteOpen(true)
  }), [])

  const openRunFromPill = (run: RunSnapshot): void => {
    const path = run.sessionPath ?? useStore.getState().sessions.find((s) => s.id === run.sessionId)?.path
    if (!path) return
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().switchSession(path)
  }

  return (
    <V3ErrorBoundary>
      <div className="v3-root" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} data-narrow={sidebarCompact ? '1' : '0'} data-side={sidebarOpen && !sidebarDragHidden ? 'open' : 'closed'} data-side-drag={sidebarDragHidden ? '1' : undefined} data-sidebar-preview={sidebarOpen ? undefined : sidebarPreview ? '1' : previewPhase === 'off' ? undefined : previewPhase} data-panel={panelMaximized ? 'maximized' : panelOpen ? panelMode : 'closed'}>
        {!sidebarOpen ? <button type="button" className="v3-sidebar-reveal" aria-label={lang === 'en-US' ? 'Show sessions' : '展开会话列表'} data-testid="v3-sidebar-reveal" onClick={() => useUiV3.getState().setSidebarOpen(true)} onPointerEnter={reveal.start} onPointerLeave={reveal.cancel} /> : null}
        <FocusScope contain={drawerOpen}>
          <Sidebar {...sidebarActions} preview={sidebarPreview && !sidebarOpen} />
        </FocusScope>
        {(sidebarOpen || sidebarDragHidden) && !sidebarCompact ? <Splitter className="v3-sidebar-resizer" value={Math.min(sidebarWidth, sidebarMax)} min={SIDEBAR_WIDTH_MIN} max={sidebarMax} step={SIDEBAR_WIDTH_STEP} largeStep={SIDEBAR_WIDTH_STEP_LARGE} collapseBelow={SIDEBAR_DRAG_COLLAPSE} onCollapse={() => useUiV3.getState().setSidebarOpen(false)} onDragHide={setSidebarDragHidden} aria-label={lang === 'en-US' ? 'Resize session list' : '调整会话列表宽度'} data-testid="v3-sidebar-resizer" onChange={setSidebarWidth} /> : null}
        {sidebarCompact && sidebarOpen ? (
          <div className="v3-scrim" onClick={() => useUiV3.getState().setSidebarOpen(false)} aria-hidden />
        ) : null}
        <main className="v3-main" inert={drawerOpen}>
          <Header
            narrow={narrow}
            sidebarOverlay={sidebarCompact}
            sidebarOpen={sidebarOpen}
            route={route.name}
            onToggleSidebar={() => useUiV3.getState().toggleSidebar()}
            onPreviewSidebar={showSidebarPreview}
            onSettings={() => openSettingsDialog()}
            onBack={() => useUiV3.getState().goBack()}
            sessionBarOpen={sessionBarOn}
            sessionBarHidden={route.name === 'chat' && sessionBarOn && hasMessages && !sessionBarShown}
            onToggleSessionBar={toggleSessionBar}
            sessionBarShown={sessionBarShown}
            rightPanelOpen={panelOpen}
            onToggleRightPanel={toggleWorkspace}
            windowControls={!(panelOpen && panelMode === 'inline')}
            openPanes={openPanes}
            activePane={activePane}
            changesDirty={changesDirty}
            terminalRunning={terminalRunning}
            onTogglePane={togglePane}
          />
          <RunAttentionToasts onOpen={openRunFromPill} />
          <div
            className="v3-body"
            ref={bodyRef}
            data-panel={panelMaximized ? 'maximized' : panelOpen ? panelMode : 'closed'}
          >
            {route.name === 'schedule' ? (
              <Suspense fallback={null}>
                <ScheduleTasksPage />
              </Suspense>
            ) : route.name === 'collab' ? (
              <Suspense fallback={null}>
                <CollabPage />
              </Suspense>
            ) : route.name === 'usage' ? (
              <Suspense fallback={null}>
                <UsagePage />
              </Suspense>
            ) : route.name === 'artifacts' ? (
              <Suspense fallback={null}>
                <ArtifactLibraryPage />
              </Suspense>
            ) : null}
            {route.name === 'chat' ? (
              <div className="v3-chat" ref={chatRef} data-sessionbar={sessionBarShown ? '1' : undefined} data-bar-anim={settledBarOn !== sessionBarOn ? '1' : undefined} style={{ '--size-tiles': `${shownTilesWidth}px`, '--size-chat-min': `${MESSAGE_MIN_WIDTH}px` } as CSSProperties}>
                <ConnBanner />
                <ChatMain />
                {sessionBarShown ? (
                  <aside className="v3-sessionbar" aria-label={lang === 'en-US' ? 'Session bar' : '会话栏'} data-testid="v3-sessionbar">
                    <OverviewPane owner={owner} onOpenView={(tab) => void openWorkspaceTab(tab)} />
                    <Splitter className="v3-tiles-resizer ui-splitter--gutter" title={railText(lang).resizeTiles} orientation="vertical" value={tilesAxis - shownTilesWidth} min={tilesAxis - tilesMaxShown} max={tilesAxis - TILES_WIDTH_MIN} step={TILES_WIDTH_STEP} aria-label={railText(lang).resizeTiles} data-testid="v3-tiles-resizer" onChange={(left) => resizeTiles(tilesAxis - left)} onReset={() => resizeTiles(TILES_WIDTH_DEFAULT)} />
                  </aside>
                ) : null}
              </div>
            ) : null}
          </div>
        </main>
        {route.name === 'chat' ? (
          <RightPanelT3
            owner={owner.key ? owner : null}
            mode={panelMode}
            room={panelRoomWidth}
            panes={WORKBENCH_PANES}
            windowControls={panelOpen && panelMode === 'inline'}
            onOpenTool={(kind) => void openWorkspaceTab(kind)}
            onRequestActivation={requestActivation}
          />
        ) : null}
      </div>
      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(name) => useUiV3.getState().navigate({ name })}
      />
      <ShortcutSheet isOpen={shortcutSheetOpen} onOpenChange={setShortcutSheetOpen} />
      <SessionSwitcher control={sessionSwitcher} />
      <SettingsPanelV3 onShowOnboarding={() => setOnboardingOpen(true)} />
      {onboardingOpen ? (
        <OnboardingWizard
          onClose={() => {
            markOnboarded()
            setOnboardingOpen(false)
          }}
        />
      ) : null}
      <NativeSessionSurfaces />
      <SessionDragLayer />
      <NoticeBridge />
      <PeerApprovalDialog />
      <BrowserSiteAskDialog />
    </V3ErrorBoundary>
  )
}
