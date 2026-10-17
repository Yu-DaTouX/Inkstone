import '../design/index.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react'
import { Splitter } from '../ui'
import { UsagePage } from '../features/usage/UsagePage'
import { translate, useI18n, type Lang, type MessageKey } from '../i18n'
import { useStore } from '../state/store'
import { useRunnerVisibility } from '../lib/use-runner-visibility'
import { useHoverDelay } from '../lib/use-hover-delay'
import { displayedSessionOf, reconcileSplit, useSplitView, type SplitSessionRef } from '../state/split-view'
import { sessionViewIdentity, viewMatchesProjectedSession } from '../features/session/view-state'
import { isModalOpen } from '../lib/modalLayer'
import { dismissBootSplash } from '../lib/boot-splash'
import { useUiV3, useV3RouteSync } from '../state/ui-v3'
import { startRunSync } from '../state/runs-v3'
import type { RunSnapshot } from '../../../shared/runs'
import { Sidebar } from '../features/sidebar/Sidebar'
import { SplitDropLayer } from '../features/sidebar/SplitDropLayer'
import { SideBySide } from './SideBySide'
import { collapsedPanes, sessionTiles } from './SideBySideLayout'
import { CommandPalette } from '../features/commands/CommandPalette'
import { ShortcutSheet } from '../features/commands/ShortcutSheet'
import { resolveV3Shortcut, shortcutOverridesFromSettings } from './shortcuts'
import { NoticeBridge } from './NoticeBridge'
import { PeerApprovalDialog } from './PeerApprovalDialog'
import { RunsPage } from '../features/runs/RunsPage'
import { ReviewPage } from '../features/review'
import { CollabPage } from '../features/collab'
import { ScheduleTasksPage } from '../features/schedule'
import { RunPill } from '../patterns/RunPill'
import { Header } from './Header'
import { applyAppearanceV3 } from '../lib/appearance-v3'
import { SettingsPanelV3 } from './SettingsPanelV3'
import { OnboardingWizard, markOnboarded, shouldAutoWizard } from '../features/onboarding'
import { NativeSessionSurfaces } from '../features/session/native'
import { V3ErrorBoundary } from './ErrorBoundary'
import { WorkbenchPanel } from '../features/workbench/WorkbenchPanel'
import { OverviewPane } from '../features/workbench/OverviewPane'
import { LANE_GAP, MESSAGE_MIN_WIDTH, SUBAGENT_LANE_EDGE, subagentPanelShownWidth, useSubagentPanel } from '../features/session/subagent-panel-state'
import { WORKBENCH_PANES } from '../features/workbench/panes'
import { useWorkspaceOwner } from '../features/workbench/use-owner'
import { revealToolTile } from '../features/workbench/tool-tiles'
import { createPanePopoutClient } from '../features/workbench/pane-popout-client'
import { activateWorkspaceOwner, captureActivationTarget } from '../features/workbench/activation'
import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId } from '../features/workbench/types'
import { panePopoutBridge, paneTerminalBridge } from '../../auxwin/pane-bridge'
import { pickOwnedTerminal, selectOwnedTerminals } from '../features/terminal/terminal-session'
import { resourceOwner } from '../state/resource-owners'
import { contextPaneData } from '../features/workbench/context-pane-view'
import type { ContextSlice } from '../state/context-breakdown'
import type { PaneContextSegment } from '../../../shared/pane-popout'
import './ShellV3.css'

let bootstrapStarted = false

const CONTEXT_SEGMENT_LABELS: Record<ContextSlice['id'], MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools'
}

function contextSegments(
  slices: readonly ContextSlice[],
  usage: { tokens: number; windowSize: number },
  lang: Lang
): PaneContextSegment[] {
  const segments: PaneContextSegment[] = slices
    .filter((slice) => slice.tokens > 0)
    .map((slice) => ({ id: slice.id, label: translate(lang, CONTEXT_SEGMENT_LABELS[slice.id]), tokens: slice.tokens }))
  const free = Math.max(0, usage.windowSize - usage.tokens)
  if (free > 0) segments.push({ id: 'free', label: translate(lang, 'ctx.cat.free'), tokens: free, tone: 'free' })
  return segments
}

async function ownedTerminalId(ownerKey: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.yan?.terminal) return null
  try {
    const list = await window.yan.terminal.list()
    return pickOwnedTerminal(selectOwnedTerminals(list, ownerKey, resourceOwner))?.id ?? null
  } catch {
    return null
  }
}

export default function ShellV3(): ReactElement {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const value = Number(localStorage.getItem('inkstone.v3.sidebarWidth')); return value >= 220 && value <= 420 ? value : 264 } catch { return 264 }
  })
  const [sidebarPreview, setSidebarPreview] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem('inkstone.v3.sidebarWidth', String(sidebarWidth)) } catch { } }, 150)
    return () => clearTimeout(timer)
  }, [sidebarWidth])
  const [workspaceWidth, setWorkspaceWidth] = useState(() => {
    try { const value = Number(localStorage.getItem('inkstone.v3.workspaceWidth')); return value >= 280 ? value : 420 } catch { return 420 }
  })
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem('inkstone.v3.workspaceWidth', String(workspaceWidth)) } catch { } }, 150)
    return () => clearTimeout(timer)
  }, [workspaceWidth])
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(1000)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth))
    observer.observe(body)
    setBodyWidth(body.clientWidth)
    return () => observer.disconnect()
  }, [])
  const maxWorkspace = Math.max(280, bodyWidth - 360)
  const shownWorkspaceWidth = Math.min(workspaceWidth, maxWorkspace)
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
  const workspaceOpen = useUiV3((s) => s.workspaceOpen)
  const workspaceTab = useUiV3((s) => s.workspaceTab)
  const hasMessages = useStore((s) => s.messages.length > 0)
  const sessionBarOn = useStore((s) => s.settings?.workspaceTiles !== false)
  const workspaceShown = route.name === 'chat' && workspaceOpen && workspaceTab !== 'overview'
  const sideOpen = useSubagentPanel((s) => !!s.runId)
  const sideWidth = useSubagentPanel((s) => s.width)
  const [sessionBarWidth] = useState(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-tiles')) || 300)
  const showSidebarPreview = useCallback(() => { if (!useUiV3.getState().sidebarOpen) setSidebarPreview(true) }, [])
  const reveal = useHoverDelay(120, showSidebarPreview)
  useEffect(() => { if (sidebarOpen) { reveal.cancel(); setSidebarPreview(false) } }, [sidebarOpen, reveal])
  const [previewPhase, setPreviewPhase] = useState<'off' | 'leaving' | 'reset'>('off')
  const previewWasOn = useRef(false)
  useEffect(() => {
    const was = previewWasOn.current
    previewWasOn.current = sidebarPreview
    if (sidebarPreview || !was || useUiV3.getState().sidebarOpen) { setPreviewPhase('off'); return }
    setPreviewPhase('leaving')
    const leaveMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-panel')) || 0
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
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const onboardDecided = useRef(false)
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia('(max-width: 899px)').matches)
  const [panelMode, setPanelMode] = useState<'docked' | 'full'>(() => (window.innerWidth < 900 ? 'full' : 'docked'))
  const [panelMounted, setPanelMounted] = useState(workspaceOpen)
  useEffect(() => { if (workspaceOpen) setPanelMounted(true) }, [workspaceOpen])

  const owner = useWorkspaceOwner()

  const [paneClient] = useState(() => {
    const bridge = panePopoutBridge()
    if (!bridge) return null
    return createPanePopoutClient({
      bridge,
      terminalBridge: paneTerminalBridge() ?? undefined,
      source: {
        snapshot: () => {
          const s = useStore.getState()
          const locale: Lang = s.settings?.lang === 'en-US' ? 'en-US' : 'zh-CN'
          const context = contextPaneData({ session: s.session, stats: s.stats, messages: s.messages })
          return {
            locale,
            context: {
              usedTokens: context.usage.tokens,
              windowTokens: context.usage.windowSize,
              known: context.usage.known,
              segments: context.usage.known ? contextSegments(context.slices, context.usage, locale) : []
            }
          }
        },
        onAction: (event) => {
          if (event.action.type === 'refresh') paneClientRef.current?.refresh(event.tab)
          if (event.action.type === 'files.attach' && event.action.path) {
            void useStore.getState().addFileRefPaths([event.action.path])
          }
        }
      }
    })
  })
  const paneClientRef = useRef(paneClient)
  paneClientRef.current = paneClient

  useEffect(() => {
    paneClient?.refresh()
  }, [paneClient, lang, owner.key])

  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.stats !== previous.stats || state.messages !== previous.messages) paneClient?.refresh('context')
      }),
    [paneClient]
  )

  useEffect(() => () => paneClient?.dispose(), [paneClient])

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
    ? JSON.stringify([settings.density, settings.fontSizeUi, settings.fontUi, settings.fontUiCustom, settings.fontCode, settings.fontCodeCustom])
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
    const apply = (): void => {
      const next = mq.matches
      setNarrow(next)
      useUiV3.getState().setSidebarOpen(!next)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const apply = (): void => {
      const w = window.innerWidth
      setPanelMode(w < 900 ? 'full' : 'docked')
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  const displayed = useMemo<SplitSessionRef | null>(
    () =>
      displayedSessionOf({
        peekedSessionId,
        peekedPath,
        session: session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : null
      }),
    [peekedSessionId, peekedPath, session?.sessionId, session?.sessionFile]
  )
  const storedSplit = useSplitView((s) => s.split)
  const split = useMemo(() => (storedSplit ? reconcileSplit(storedSplit, displayed) : null), [storedSplit, displayed])
  useLayoutEffect(() => {
    useSplitView.getState().sync(displayed)
  }, [displayed, storedSplit])
  const visibleSessions = useMemo(() => {
    const layout = collapsedPanes(split, narrow)
    return layout ? sessionTiles(layout.tiles) : displayed ? [displayed] : []
  }, [split, narrow, displayed])
  useRunnerVisibility(visibleSessions)
  const singlePane = !collapsedPanes(split, narrow)
  const chatWidth = bodyWidth - (workspaceShown && panelMode === 'docked' ? shownWorkspaceWidth : 0)
  const sideReserve = subagentPanelShownWidth(sideWidth, chatWidth, SUBAGENT_LANE_EDGE) + LANE_GAP
  const panelInChat = singlePane && chatWidth - sideReserve >= MESSAGE_MIN_WIDTH
  const sideInLane = sideOpen && panelInChat
  const sessionBarFits = (!sideOpen || sideInLane) && chatWidth - (sideInLane ? sideReserve : 0) - (sessionBarWidth + LANE_GAP) >= MESSAGE_MIN_WIDTH
  const sessionBarShown = route.name === 'chat' && singlePane && hasMessages && sessionBarOn && sessionBarFits && !(workspaceShown && panelMode === 'full')

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

  const toggleWorkspace = (): void => {
    const ui = useUiV3.getState()
    if (ui.workspaceOpen && ui.workspaceTab !== 'overview') {
      ui.setWorkspaceOpen(false)
      return
    }
    void openWorkspaceTab(ui.workspaceTab === 'overview' ? 'changes' : ui.workspaceTab)
  }

  const toggleSessionBar = (): void => {
    void useStore.getState().patchSettings({ workspaceTiles: !sessionBarOn }).catch(() => undefined)
  }

  const requestActivation = (_tab: WorkbenchTabId): Promise<boolean> => activateWorkspaceOwner(captureActivationTarget())

  useEffect(() => {
    if (nativeSessionPanel?.mode !== 'tree') return
    setPanelMounted(true)
    useUiV3.getState().setWorkspaceTab('branch')
    useUiV3.getState().setWorkspaceOpen(true)
    useStore.getState().closeNativeSessionPanel()
  }, [nativeSessionPanel])

  const openWorkspaceTab = (tab: WorkbenchTabId): Promise<boolean> => {
    useUiV3.getState().navigate({ name: 'chat' })
    if (revealToolTile(tab)) return Promise.resolve(true)
    setPanelMounted(true)
    useUiV3.getState().setWorkspaceTab(tab)
    if (!WORKBENCH_ACTIVE_TABS.has(tab)) {
      useUiV3.getState().setWorkspaceOpen(true)
      return Promise.resolve(true)
    }
    return activateWorkspaceOwner(captureActivationTarget()).then((ok) => {
      if (ok) useUiV3.getState().setWorkspaceOpen(true)
      return ok
    })
  }

  useEffect(() => {
    const off = window.yan.onHotkey((action) => {
      const store = useStore.getState()
      if (action === 'cycleModel') void store.cycleModel()
      else if (action === 'cycleModelBack') void store.cycleModelBack()
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
          case 'toggleSidebar':
            event.preventDefault()
            ui.toggleSidebar()
            return
          case 'openRuns':
            event.preventDefault()
            ui.navigate({ name: 'runs' })
            return
          case 'toggleWorkspace':
            event.preventDefault()
            toggleWorkspace()
            return
          case 'openSettings':
            event.preventDefault()
            ui.navigate({ name: 'settings' })
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
        }
      }
      if (event.key === 'Escape' && !typing) {
        const ui = useUiV3.getState()
        if (ui.workspaceOpen && panelMode === 'full') ui.setWorkspaceOpen(false)
        else if (ui.route.name !== 'chat') ui.goBack()
        else if (narrow && ui.sidebarOpen) ui.setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow, paletteOpen, panelMode, toggleWorkspace, openWorkspaceTab])

  const openSessionFromRuns = (path: string): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().switchSession(path)
  }

  const sidebarActions = useMemo(() => ({
    onClose: () => { setSidebarPreview(false); useUiV3.getState().setSidebarOpen(false) },
    onPin: () => useUiV3.getState().setSidebarOpen(true),
    onRuns: () => useUiV3.getState().navigate({ name: 'runs' }),
    onSchedule: () => useUiV3.getState().navigate({ name: 'schedule' }),
    onReview: () => useUiV3.getState().navigate({ name: 'review' }),
    onCollab: () => useUiV3.getState().navigate({ name: 'collab' }),
    onSettings: () => useUiV3.getState().navigate({ name: 'settings' })
  }), [])

  const openRunFromPill = (run: RunSnapshot): void => {
    const path = run.sessionPath ?? useStore.getState().sessions.find((s) => s.id === run.sessionId)?.path
    if (!path) return
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().switchSession(path)
  }

  return (
    <V3ErrorBoundary>
      <div className="v3-root" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} data-narrow={narrow ? '1' : '0'} data-side={sidebarOpen ? 'open' : 'closed'} data-sidebar-preview={sidebarOpen ? undefined : sidebarPreview ? '1' : previewPhase === 'off' ? undefined : previewPhase}>
        {!sidebarOpen ? <button type="button" className="v3-sidebar-reveal" aria-label={lang === 'en-US' ? 'Show sessions' : '展开会话列表'} data-testid="v3-sidebar-reveal" onClick={() => useUiV3.getState().setSidebarOpen(true)} onPointerEnter={reveal.start} onPointerLeave={reveal.cancel} /> : null}
        <Sidebar {...sidebarActions} preview={sidebarPreview && !sidebarOpen} />
        {sidebarOpen && !narrow ? <Splitter className="v3-sidebar-resizer" value={sidebarWidth} min={220} max={420} step={16} aria-label={lang === 'en-US' ? 'Resize session list' : '调整会话列表宽度'} data-testid="v3-sidebar-resizer" onChange={setSidebarWidth} onReset={() => setSidebarWidth(264)} /> : null}
        {narrow && sidebarOpen ? (
          <div className="v3-scrim" onClick={() => useUiV3.getState().setSidebarOpen(false)} aria-hidden />
        ) : null}
        <div className="v3-main">
          <Header
            narrow={narrow}
            sidebarOpen={sidebarOpen}
            route={route.name}
            onToggleSidebar={() => useUiV3.getState().toggleSidebar()}
            onPreviewSidebar={showSidebarPreview}
            onSettings={() => useUiV3.getState().navigate({ name: 'settings' })}
            onBack={() => useUiV3.getState().goBack()}
            sessionBarOpen={sessionBarOn}
            onToggleSessionBar={toggleSessionBar}
            onOpenTool={(tab) => void openWorkspaceTab(tab)}
          />
          <div
            className="v3-body"
            ref={bodyRef}
            style={{ '--workspace-width': `${shownWorkspaceWidth}px` } as CSSProperties}
            data-workspace={workspaceShown ? 'open' : 'closed'}
            data-workspace-mode={panelMode}
          >
            {route.name === 'settings' ? (
              <SettingsPanelV3 onShowOnboarding={() => setOnboardingOpen(true)} />
            ) : route.name === 'runs' ? (
              <RunsPage onOpenSession={openSessionFromRuns} />
            ) : route.name === 'schedule' ? (
              <ScheduleTasksPage />
            ) : route.name === 'review' ? (
              <ReviewPage />
            ) : route.name === 'collab' ? (
              <CollabPage />
            ) : route.name === 'usage' ? (
              <UsagePage />
            ) : (
              <div className="v3-chat" data-sessionbar={sessionBarShown ? '1' : undefined} data-side-panel={sideInLane ? '1' : undefined}>
                <RunPill
                  className="v3-pillbar"
                  onOpen={openRunFromPill}
                  onShowAll={() => useUiV3.getState().navigate({ name: 'runs' })}
                />
                <SideBySide split={split} narrow={narrow} panelInChat={panelInChat} />
                {sessionBarShown ? (
                  <aside className="v3-sessionbar" aria-label={lang === 'en-US' ? 'Session bar' : '会话栏'} data-testid="v3-sessionbar">
                    <OverviewPane owner={owner} onOpenView={(tab) => void openWorkspaceTab(tab)} />
                  </aside>
                ) : null}
              </div>
            )}
            {panelMounted ? (
              <WorkbenchPanel
                owner={owner}
                open={workspaceShown}
                mode={panelMode}
                panes={WORKBENCH_PANES}
                onClose={() => useUiV3.getState().setWorkspaceOpen(false)}
                onRequestActivation={requestActivation}
                onPopout={(tab) => {
                  if (!paneClient || !owner) return
                  if (tab === 'terminal') {
                    void ownedTerminalId(owner.key).then((terminalId) => {
                      if (terminalId) void paneClient.openTerminal(owner, terminalId)
                    })
                    return
                  }
                  if (tab === 'browser') {
                    const viewId = useStore.getState().browserState.activeTabId
                    if (viewId) void paneClient.open('browser', owner, { viewId })
                    return
                  }
                  if (tab === 'context') void paneClient.open('context', owner)
                }}
              />
            ) : null}
            {workspaceShown && panelMode === 'docked' ? (
              <Splitter className="v3-workspace-resizer" quiet orientation="vertical" value={bodyWidth - shownWorkspaceWidth} min={360} max={bodyWidth - 280} step={16} aria-label={lang === 'en-US' ? 'Resize workspace' : '调整工作区宽度'} onChange={(left) => setWorkspaceWidth(bodyWidth - left)} onReset={() => setWorkspaceWidth(420)} />
            ) : null}
          </div>
        </div>
      </div>
      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(name) => useUiV3.getState().navigate({ name })}
      />
      <ShortcutSheet isOpen={shortcutSheetOpen} onOpenChange={setShortcutSheetOpen} />
      {onboardingOpen ? (
        <OnboardingWizard
          onClose={() => {
            markOnboarded()
            setOnboardingOpen(false)
          }}
        />
      ) : null}
      <NativeSessionSurfaces />
      <SplitDropLayer />
      <NoticeBridge />
      <PeerApprovalDialog />
    </V3ErrorBoundary>
  )
}
