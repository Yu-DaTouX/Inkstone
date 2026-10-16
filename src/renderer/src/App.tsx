import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VList, type VListHandle } from 'virtua'
import { IconSprite } from './icons/Icon'
import { PeerApprovalDialog } from './components/shell/PeerApprovalDialog'
import { ConfirmProvider, useCancelConfirms } from './components/ui/confirm'
import { SessionSwitcher } from './components/shell/SessionSwitcher'
import { ShortcutSheet } from './components/shell/ShortcutSheet'
import { resolveShortcut } from './lib/host-actions'
import { focusComposerInput } from './lib/use-host-actions'
import { RewindDialog } from './components/shell/RewindDialog'
import { useI18n, useT } from './i18n'
import { TitleBar, type Theme } from './components/shell/TitleBar'
import { Rail } from './components/rail/Rail'
import { applyBackground, customForTheme } from './lib/background'
import { APPEARANCE_EVENT, applyTypography } from './lib/appearance'
import { useStreamHeight } from './lib/useStreamHeight'
import { useRunnerVisibility } from './lib/use-runner-visibility'
import { Workspace, WorkspacePane } from './components/workbench/Workspace'
import { conversationKeyOf, rememberConversationKey, workspaceKeyFor } from './state/workspace-key'
import { splitTileKey, displayedSessionOf, reconcileSplit, useSplitView, type SplitSessionRef } from './state/split-view'
import { CHAT_PANE, DOCK_GAP } from './state/workspace-layout'
import { SplitResizer } from './components/chat/SplitResizer'
import { rememberScroll, rememberShown, restoreScrollAnchor, scrollAnchorOf, shownScroll, type ScrollAnchor } from './state/split-snapshots'
import { SplitPaneHead, SplitPeerPane, closeSplitTile, focusSplitSession } from './components/chat/SplitPeerPane'
import { SplitDropZone } from './components/chat/SplitDropZone'
import { RightPanel } from './components/toolbar/RightPanel'
import { FloatingTiles } from './components/toolbar/FloatingTiles'
import { Resizer } from './components/toolbar/Resizer'
import { InteractionSession } from './lib/interaction-state'
import { ConversationOutline } from './components/chat/ConversationOutline'
import { Continuity, EmptyStream } from './components/chat/Continuity'
import { TurnView } from './components/chat/TurnView'
import { PendingActivity } from './components/chat/TurnProcess'
import { createTurnProjector } from '../../shared/turns'
import { mergeQuestionLog } from '../../shared/question-log'
import { isModalOpen } from './lib/modalLayer'
import { Composer } from './components/chat/Composer'
import { NativeSessionSurface } from './components/chat/NativeSessionSurface'
import { SubagentNote } from './components/chat/SubagentNote'
import { SchedulePage } from './components/schedule/SchedulePage'
import { Settings, type SettingsTab } from './components/settings/Settings'
import { Onboarding } from './components/settings/Onboarding'
import { OnboardingWizard } from './components/settings/OnboardingWizard'
import { markOnboarded, shouldAutoWizard } from './components/settings/onboarding-state'
import { ConnBar, Notices, UiDialog } from './components/shell/UiBridge'
import { StatusBar } from './components/shell/StatusBar'
import { dismissBootSplash } from './lib/boot-splash'
import { streamingMessageId, useStore } from './state/store'
import './styles/index.css'

const VIRTUALIZE_AT = 80
const VIRTUALIZE_MSGS_AT = 200

function listLooksBlank(list: HTMLElement | null | undefined): boolean {
  if (!list) return false
  const box = list.getBoundingClientRect()
  if (box.height < 40) return false
  const rows = list.querySelectorAll('.stream-row')
  if (rows.length === 0) return true
  for (const row of rows) {
    const r = row.getBoundingClientRect()
    if (r.height > 0 && r.bottom > box.top + 1 && r.top < box.bottom - 1) return false
  }
  return true
}

function readTheme(parent: Theme | undefined): Theme {
  if (parent) return parent
  try {
    const v = localStorage.getItem('yan.theme')
    if (v === 'light' || v === 'dark') return v
  } catch {
  }
  return 'dark'
}

const THEME_BUTTON_SELECTOR = '[data-testid^="theme-"]'

function themeButtonOrigin(): { x: number; y: number } | null {
  const center = (el: Element | null | undefined): { x: number; y: number } | null => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (!rect.width && !rect.height) return null
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return null
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  const focused = document.activeElement
  const byFocus = focused instanceof Element ? focused.closest(THEME_BUTTON_SELECTOR) : null
  return center(byFocus) ?? center(document.querySelector(THEME_BUTTON_SELECTOR))
}

function ConfirmSessionGuard(): null {
  const cancel = useCancelConfirms()
  const conversation = useStore((s) => conversationKeyOf(s.session))
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    cancel()
  }, [conversation, cancel])
  return null
}

export default function App() {
  const { lang, setLang } = useI18n()
  const t = useT()
  const [theme, setTheme] = useState<Theme>(() => readTheme(undefined))
  const themeMounted = useRef(false)
  const themeOrigin = useRef<{ x: number; y: number } | null>(null)
  const themeTransitionRunning = useRef(false)
  const [wizard, setWizard] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const refreshCheckpoints = useStore((s) => s.refreshCheckpoints)
  const checkToolchainNotice = useStore((s) => s.checkToolchainNotice)
  const checkpointKey = useStore((s) => s.session?.conversationId ?? s.session?.sessionId ?? '')
  const checkpointMessages = useStore((s) => s.messages.length)
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCheckpoints(), 400)
    return () => window.clearTimeout(timer)
  }, [refreshCheckpoints, checkpointKey, checkpointMessages])
  const onboardDecided = useRef(false)
  const railPinned = useStore((s) => s.railPinned)
  const railPinnedRef = useRef(railPinned)
  railPinnedRef.current = railPinned
  const setRailPinned = useStore((s) => s.setRailPinned)
  const browserOpen = useStore((s) => s.browserState.open)
  const openBrowser = useStore((s) => s.openBrowser)
  const closeBrowser = useStore((s) => s.closeBrowser)
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const cycleModel = useStore((s) => s.cycleModel)
  const cycleModelBack = useStore((s) => s.cycleModelBack)
  const cycleThinking = useStore((s) => s.cycleThinking)

  const railOpen = railPinned
  const [railPeek, setRailPeek] = useState(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRail = (inside: boolean): void => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setRailPeek(inside && !railPinnedRef.current), inside ? 140 : 260)
  }
  useEffect(() => { if (railPinned) setRailPeek(false) }, [railPinned])
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current) }, [])
  const settingsOpen = useStore((s) => s.settingsOpen)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  useEffect(() => {
    const open = (): void => setScheduleOpen(true)
    window.addEventListener('inkstone-schedule-open', open)
    return () => window.removeEventListener('inkstone-schedule-open', open)
  }, [])
  const settingsTab = useStore((s) => s.settingsTab as SettingsTab)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const userTouched = useRef({ theme: false, lang: false })

  const conn = useStore((s) => s.conn)
  const messages = useStore((s) => s.messages)
  const questionLog = useStore((s) => s.questionLog)
  const questionLogSession = useStore((s) => s.questionLogSession)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const storedSplit = useSplitView((s) => s.split)
  const splitWeights = useSplitView((s) => s.weights)
  const displayedSession = useMemo<SplitSessionRef | null>(
    () => displayedSessionOf({ peekedSessionId, peekedPath, session: session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : null }),
    [peekedSessionId, peekedPath, session?.sessionId, session?.sessionFile]
  )
  const split = storedSplit ? reconcileSplit(storedSplit, displayedSession) : null
  useRunnerVisibility(split?.tiles ?? (displayedSession ? [displayedSession] : []))
  rememberConversationKey(session)
  useLayoutEffect(() => { useSplitView.getState().sync(displayedSession) }, [displayedSession, storedSplit])
  const shownGuard = useRef<{ key: string; last: unknown }>({ key: '', last: null })
  useEffect(() => {
    if (!displayedSession) return
    const key = displayedSession.path ?? displayedSession.sessionId ?? ''
    const stale = shownGuard.current.key !== key && messages === shownGuard.current.last
    shownGuard.current = { key, last: messages }
    if (!stale) rememberShown(displayedSession, messages)
  }, [displayedSession, messages])
  const scrollNote = useRef<{ raf: number; top: number; atBottom: boolean; anchor?: ScrollAnchor; settleAt: number; identity: string; target: SplitSessionRef | null }>({ raf: 0, top: 0, atBottom: true, settleAt: 0, identity: '', target: null })
  const scrollIdentity = displayedSession?.path ?? displayedSession?.sessionId ?? ''
  if (scrollNote.current.identity !== scrollIdentity) {
    scrollNote.current.identity = scrollIdentity
    scrollNote.current.settleAt = performance.now() + 150
  }
  const noteScroll = (top: number, atBottom: boolean, container?: HTMLElement | null): void => {
    const note = scrollNote.current
    if (!displayedSession || performance.now() < note.settleAt) return
    if (note.target && note.target !== displayedSession && note.raf) { cancelAnimationFrame(note.raf); note.raf = 0 }
    note.target = displayedSession
    note.top = top
    note.atBottom = atBottom
    note.anchor = atBottom ? undefined : scrollAnchorOf(container)
    if (note.raf) return
    note.raf = requestAnimationFrame(() => {
      note.raf = 0
      if (note.target) rememberScroll(note.target, { top: note.top, atBottom: note.atBottom, anchor: note.anchor })
    })
  }
  const settings = useStore((s) => s.settings)
  const bootstrap = useStore((s) => s.bootstrap)
  const startConnWatch = useStore((s) => s.startConnWatch)
  const maximized = useStore((s) => s.maximized)
  const registerScrollToTurn = useStore((s) => s.registerScrollToTurn)
  const applyPush = useStore((s) => s.applyPush)
  const streamRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<VListHandle>(null)
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)
  const suppressStickScrollRef = useRef(false)
  const scrollIntentRef = useRef(0)
  const setStickNow = (v: boolean): void => {
    scrollIntentRef.current += 1
    stickRef.current = v
    setStick(v)
  }

  const runTail = useStore((s) => s.runTail)
  const streamingId = streamingMessageId({ session, messages, runTail })

  const projectTurns = useMemo(() => createTurnProjector(), [])
  const turns = useMemo(
    () =>
      projectTurns(
        mergeQuestionLog(messages, questionLogSession && questionLogSession === session?.sessionId ? questionLog : []),
        streamingId
      ),
    [messages, questionLog, questionLogSession, session?.sessionId, streamingId, projectTurns]
  )

  const awaitingReply = turns.length > 0 && turns[turns.length - 1].kind !== 'assistant' && !!(session?.isAgentRunning || session?.isStreaming)
  const renderTurns = useMemo(
    () => awaitingReply ? [...turns, { kind: 'pending' as const, id: '__pending__' }] : turns,
    [turns, awaitingReply]
  )

  const virtual = turns.length >= VIRTUALIZE_AT || messages.length >= VIRTUALIZE_MSGS_AT

  useEffect(() => {
    const off = window.yan.onPush(applyPush)
    void bootstrap()
    startConnWatch()
    return off
  }, [applyPush, bootstrap, startConnWatch])

  const bootConn = useStore((s) => s.conn)
  const bootSession = useStore((s) => s.session)
  useEffect(() => { performance.mark('yan:conn-' + bootConn) }, [bootConn])
  useEffect(() => { if (bootSession) performance.mark('yan:session-known') }, [!!bootSession])
  useEffect(() => {
    if (!settings) return
    const settled = bootConn === 'exited' || bootConn === 'error' || (bootConn === 'ready' && !!bootSession)
    if (!settled) return
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(dismissBootSplash) })
    return () => cancelAnimationFrame(id)
  }, [settings, bootConn, bootSession])

  useEffect(() => {
    if (onboardDecided.current) return
    if (!settings) return
    onboardDecided.current = true
    if (window.yan.isProbe) {
      checkToolchainNotice()
      return
    }
    if (shouldAutoWizard()) setWizard(true)
    checkToolchainNotice()
  }, [settings, checkToolchainNotice])

  useEffect(() => {
    if (!settings) return
    if (!userTouched.current.theme && settings.theme !== theme) setTheme(settings.theme)
    if (!userTouched.current.lang && settings.lang !== lang) setLang(settings.lang)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  useEffect(() => {
    const onTheme = (e: Event): void => {
      const detail = (e as CustomEvent).detail as
        | 'dark'
        | 'light'
        | { theme?: 'dark' | 'light'; origin?: { x: number; y: number } }
        | undefined
      const next = typeof detail === 'string' ? detail : detail?.theme
      const origin = typeof detail === 'object' && detail ? detail.origin : undefined
      if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
        themeOrigin.current = { x: origin.x, y: origin.y }
      }
      if (next === 'dark' || next === 'light') {
        userTouched.current.theme = true
        setTheme(next)
      }
    }
    window.addEventListener('yan:theme', onTheme)
    return () => window.removeEventListener('yan:theme', onTheme)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      root.dataset.theme = theme
      const colors = applyBackground(
        root,
        settings?.backgroundPreset,
        customForTheme(settings?.backgroundCustom, settings?.backgroundCustomLight, theme),
        theme
      )
      if (colors) window.dispatchEvent(new Event(APPEARANCE_EVENT))
    }
    root.dataset.themeDir = theme === 'dark' ? 'out' : 'in'
    const origin = themeOrigin.current ?? themeButtonOrigin()
    themeOrigin.current = null
    if (origin) {
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      root.style.setProperty('--theme-origin-x', `${((origin.x / vw) * 100).toFixed(3)}%`)
      root.style.setProperty('--theme-origin-y', `${((origin.y / vh) * 100).toFixed(3)}%`)
    } else {
      root.style.removeProperty('--theme-origin-x')
      root.style.removeProperty('--theme-origin-y')
    }

    const transitionDocument = document as Document & {
      startViewTransition?: (update: () => void) => { finished?: Promise<void>; updateCallbackDone?: Promise<void> } | undefined
    }
    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const firstThemeApply = !themeMounted.current
    themeMounted.current = true
    const canTransition =
      !firstThemeApply && typeof transitionDocument.startViewTransition === 'function' && !reduceMotion
    if (canTransition && !themeTransitionRunning.current) {
      themeTransitionRunning.current = true
      const done = (): void => {
        themeTransitionRunning.current = false
      }
      const transition = transitionDocument.startViewTransition(apply)
      if (transition?.updateCallbackDone) transition.updateCallbackDone.then(undefined, apply)
      if (transition?.finished) {
        const timer = window.setTimeout(done, 900)
        transition.finished.then(
          () => {
            window.clearTimeout(timer)
            done()
          },
          () => {
            window.clearTimeout(timer)
            done()
          }
        )
      } else {
        done()
      }
    } else {
      apply()
    }
    try {
      localStorage.setItem('yan.theme', theme)
    } catch {
    }
    if (settings && settings.theme !== theme) void window.yan.patchSettings({ theme })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  useEffect(() => {
    if (settings && settings.lang !== lang) void window.yan.patchSettings({ lang })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  const density = settings?.density ?? 'standard'
  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  useEffect(() => {
    const root = document.documentElement
    const w = settings?.streamWidth ?? 0
    if (w > 0) root.style.setProperty('--w-stream', `${w}px`)
    else root.style.removeProperty('--w-stream')
    window.dispatchEvent(new Event('yan:stream-width'))
  }, [settings?.streamWidth])

  useEffect(() => {
    const root = document.documentElement
    const colors = applyBackground(root, settings?.backgroundPreset, customForTheme(settings?.backgroundCustom, settings?.backgroundCustomLight, theme), theme)
    if (colors) window.dispatchEvent(new Event(APPEARANCE_EVENT))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.backgroundPreset, settings?.backgroundCustom, settings?.backgroundCustomLight])

  useEffect(() => {
    const root = document.documentElement
    const type = applyTypography(root, settings ?? {})
    if (type) {
      window.dispatchEvent(new Event(APPEARANCE_EVENT))
      window.dispatchEvent(new Event('yan:stream-width'))
    }
  }, [
    settings?.fontUi, settings?.fontUiCustom, settings?.fontCode, settings?.fontCodeCustom, settings?.fontSizeBody, settings?.fontSizeUi
  ])

  useEffect(() => {
    document.documentElement.dataset.procLayout = settings?.processLayout === 'side' || settings?.processLayout === 'left' ? settings.processLayout : 'inline'
  }, [settings?.processLayout])

  useEffect(() => {
    if (!stickRef.current || suppressStickScrollRef.current) return
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [renderTurns, stick, virtual, split?.live])
  const stickObserver = useRef<ResizeObserver | null>(null)
  const setStreamNode = useCallback((node: HTMLDivElement | null): void => {
    streamRef.current = node
    stickObserver.current?.disconnect()
    stickObserver.current = null
    const inner = node?.firstElementChild
    if (!node || !inner) return
    const observer = new ResizeObserver(() => { if (stickRef.current && !suppressStickScrollRef.current) node.scrollTop = node.scrollHeight })
    observer.observe(inner)
    observer.observe(node)
    stickObserver.current = observer
  }, [])

  const centerRef = useRef<HTMLElement>(null)
  useStreamHeight(centerRef)
  const [vlistKey, setVlistKey] = useState(0)
  const vlistRemounts = useRef(0)
  const vlistSettlingRef = useRef(false)
  const lastTurnIndexRef = useRef(0)
  lastTurnIndexRef.current = Math.max(0, turns.length - 1)
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  useEffect(() => {
    if (!virtual) return undefined
    if (vlistKey === 0) vlistRemounts.current = 0
    const wasStick = stickRef.current
    const intent = scrollIntentRef.current
    vlistSettlingRef.current = true
    let frames = 0
    let raf = 0
    const tick = (): void => {
      const list = centerRef.current?.querySelector<HTMLElement>('.stream')
      const blank = listLooksBlank(list)
      if (blank && vlistRemounts.current < 3) {
        vlistRemounts.current += 1
        setVlistKey((k) => k + 1)
        return
      }
      if (wasStick && intent === scrollIntentRef.current && stickRef.current && !suppressStickScrollRef.current) {
        vlistRef.current?.scrollToIndex(lastTurnIndexRef.current, { align: 'end' })
      }
      vlistSettlingRef.current = false
      if (++frames < 24) {
        raf = requestAnimationFrame(tick)
        return
      }
      vlistSettlingRef.current = false
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      vlistSettlingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split?.live, !!split, virtual, vlistKey, scrollIdentity])

  const splitOn = !!split
  const sessionIdentity = displayedSession?.path ?? displayedSession?.sessionId ?? ''
  useLayoutEffect(() => {
    if (!displayedSession) return undefined
    const snap = shownScroll(displayedSession)
    const bottom = !snap || snap.atBottom
    stickRef.current = bottom
    setStick(bottom)
    vlistSettlingRef.current = true
    const intent = scrollIntentRef.current
    const raf = requestAnimationFrame(() => {
      if (intent !== scrollIntentRef.current) {
        vlistSettlingRef.current = false
        return
      }
      if (virtual) {
        const at = snap?.anchor ? turnsRef.current.findIndex((tt) => tt.id === snap.anchor!.turnId) : -1
        if (bottom) vlistRef.current?.scrollToIndex(lastTurnIndexRef.current, { align: 'end' })
        else if (at >= 0) vlistRef.current?.scrollToIndex(at, { align: 'start', offset: snap!.anchor!.offset })
        else if (snap) vlistRef.current?.scrollTo(snap.top)
      } else if (streamRef.current) {
        if (bottom) streamRef.current.scrollTop = streamRef.current.scrollHeight
        else if (!restoreScrollAnchor(streamRef.current, snap!.anchor)) streamRef.current.scrollTop = snap!.top
        vlistSettlingRef.current = false
      }
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split?.live, sessionIdentity, splitOn, virtual, vlistKey])

  useEffect(() => {
    vlistRemounts.current = 0
  }, [sessionIdentity, split?.live])
  useEffect(() => {
    if (!virtual || !split) return undefined
    const timer = window.setInterval(() => {
      if (vlistSettlingRef.current || vlistRemounts.current >= 3) return
      const list = centerRef.current?.querySelector<HTMLElement>('.stream')
      if (!listLooksBlank(list)) return
      vlistRemounts.current += 1
      setVlistKey((k) => k + 1)
    }, 500)
    return () => window.clearInterval(timer)
  }, [virtual, !!split])

  const onScroll = () => {
    const el = streamRef.current
    if (!el) return
    if (suppressStickScrollRef.current || vlistSettlingRef.current) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setStickNow(atBottom)
    noteScroll(el.scrollTop, atBottom, el)
  }

  useEffect(() => {
    registerScrollToTurn((turnIndex: number) => {
      const userTurns: number[] = []
      turns.forEach((tt, i) => {
        if (tt.kind === 'user') userTurns.push(i)
      })
      const target = userTurns[turnIndex]
      if (target === undefined) return

      suppressStickScrollRef.current = true
      setStickNow(false)

      if (virtual) {
        vlistRef.current?.scrollToIndex(target, { align: 'start' })
        requestAnimationFrame(() => {
          suppressStickScrollRef.current = false
          setStickNow(false)
        })
        return
      }

      const turn = turns[target]

      requestAnimationFrame(() => {
          const applyTargetScroll = (): void => {
            const box = streamRef.current
            const el = box?.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`)
            if (!box || !el) return
            const targetTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
            box.scrollTop = Math.max(0, targetTop)
          }
          applyTargetScroll()
        requestAnimationFrame(() => {
          applyTargetScroll()
          suppressStickScrollRef.current = false
          setStickNow(false)
        })
      })
    })
  }, [turns, virtual, registerScrollToTurn])

  const onVirtualScroll = () => {
    const h = vlistRef.current
    if (!h || suppressStickScrollRef.current || vlistSettlingRef.current) return
    const atBottom = h.scrollSize - h.scrollOffset - h.viewportSize < 40
    setStickNow(atBottom)
    noteScroll(h.scrollOffset, atBottom, centerRef.current?.querySelector<HTMLElement>('.stream'))
  }

  const jumpToBottom = () => {
    setStickNow(true)
    if (virtual) {
      vlistRef.current?.scrollToIndex(turns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    const off = window.yan.onHotkey((action) => {
      if (action === 'cycleModel') void cycleModel()
      else if (action === 'cycleModelBack') void cycleModelBack()
      else if (action === 'cycleThinking') void cycleThinking()
    })

    let lastAt = 0
    const guard = (action: 'cycleModel' | 'cycleModelBack' | 'cycleThinking'): void => {
      const now = Date.now()
      if (now - lastAt < 250) return
      lastAt = now
      if (action === 'cycleModel') void cycleModel()
      else if (action === 'cycleModelBack') void cycleModelBack()
      else void cycleThinking()
    }

    const onKey = (e: KeyboardEvent): void => {
      const shortcut = resolveShortcut({
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
        composing: e.isComposing,
        repeat: e.repeat,
        altGraph: typeof e.getModifierState === 'function' ? e.getModifierState('AltGraph') : false,
        inTerminal: !!(e.target as HTMLElement | null)?.closest?.('.xterm'),
        modalOpen: isModalOpen()
      })
      if (!shortcut) return
      switch (shortcut) {
        case 'cycleModelBack':
          e.preventDefault()
          guard('cycleModelBack')
          return
        case 'cycleModel':
          e.preventDefault()
          guard('cycleModel')
          return
        case 'cycleThinking':
          e.preventDefault()
          guard('cycleThinking')
          return
        case 'openSettings':
          e.preventDefault()
          openSettings()
          return
        case 'shortcutSheet':
          e.preventDefault()
          setSheetOpen(true)
          return
        case 'toggleRail':
          e.preventDefault()
          setRailPinned(!railPinnedRef.current)
          return
        case 'focusComposer':
          e.preventDefault()
          focusComposerInput()
          return
        case 'copyLastReply':
          e.preventDefault()
          void useStore.getState().copyLastReply()
          return
        case 'openSessionSwitcher':
          e.preventDefault()
          setSwitcherOpen((open) => !open)
          return
        case 'newSession':
          e.preventDefault()
          void useStore.getState().newSession({ scope: 'global' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [cycleModel, cycleModelBack, cycleThinking, openSettings, setRailPinned])

  const appCls = [
    'app',
    !railOpen && 'rail-off',
    !railOpen && railPeek && 'rail-peek',
    railPinned && 'rail-pinned'
  ]
    .filter(Boolean)
    .join(' ')

  const sessionHeader = <Continuity />
  const chatColumn = (
          <InteractionSession.Provider value={displayedSession?.sessionId ?? ''}>
          <section ref={centerRef} className={`center${split ? ' split-live' : ''}`} data-testid={split ? 'split-live' : undefined}>
            {split ? <SplitPaneHead index={split.live} target={split.tiles[split.live]}>{sessionHeader}</SplitPaneHead> : null}
            {conn !== 'ready' ? <ConnBar conn={conn} /> : null}

            <ConversationOutline />

            {virtual ? (
              <VList
                key={`${sessionIdentity}|${vlistKey}`}
                ref={vlistRef}
                data={renderTurns}
                className="stream"
                bufferSize={800}
                onScroll={onVirtualScroll}
              >
                {(tt) => (
                  <div key={tt.id} className="stream-row">
                    {tt.kind === 'pending' ? <PendingActivity /> : <TurnView turn={tt} streaming={tt.kind === 'assistant' && tt.streaming} />}
                  </div>
                )}
              </VList>
            ) : (
              <div className="stream" ref={setStreamNode} onScroll={onScroll}>
                <div className="stream-inner">
                  {turns.length === 0 ? (
                    <EmptyStream />
                  ) : (
                    renderTurns.map((tt) => tt.kind === 'pending' ? (
                      <PendingActivity key={tt.id} />
                    ) : (
                      <TurnView
                        key={tt.id}
                        turn={tt}
                        streaming={tt.kind === 'assistant' && tt.streaming}
                      />
                    ))
                  )}
                </div>
              </div>
            )}

            {!stick ? (
              <div className="jump-anchor">
                <button
                  className="jump-bottom"
                  onClick={jumpToBottom}
                  aria-label={t('chat.jumpToBottom')}
                  title={t('chat.jumpToBottom')}
                >
                  <span className="jump-ico" aria-hidden="true">↓</span>
                </button>
              </div>
            ) : null}

            <SubagentNote />
            <Composer />
          </section>
          </InteractionSession.Provider>
  )

  return (
    <ConfirmProvider>
    <>
      <ConfirmSessionGuard />
      <IconSprite />
      <PeerApprovalDialog />
      {switcherOpen ? <SessionSwitcher onClose={() => setSwitcherOpen(false)} onOpenShortcutSheet={() => setSheetOpen(true)} /> : null}
      {sheetOpen ? <ShortcutSheet onClose={() => setSheetOpen(false)} /> : null}
      <RewindDialog />
      <div className={appCls}>
        <TitleBar
          onToggleRail={() => setRailPinned(!railPinned)}
          railOpen={railOpen}
          onRailHover={hoverRail}
          onToggleBrowser={() => void (browserOpen ? closeBrowser() : openBrowser())}
          browserOpen={browserOpen}
          alwaysOnTop={alwaysOnTop}
          onToggleAlwaysOnTop={() => void toggleAlwaysOnTop()}
          maximized={maximized}
          onSettings={() => (settingsOpen ? closeSettings() : openSettings())}
          center={split ? null : sessionHeader}
        />

        <div className="workspace workspace-tiled">
        <div className="rail-slot" onPointerEnter={() => { if (!railOpen) hoverRail(true) }} onPointerLeave={() => { if (!railOpen) hoverRail(false) }}>
          <Rail />
          <Resizer side="rail" />
        </div>

          {split ? (
            <div className="split-row" data-testid="split-row">
              {split.tiles.map((tile, i) => {
                const live = split.live === i
                const tileKey = splitTileKey(tile) || `tile-${i}`
                const columnKey = workspaceKeyFor(tile)
                return (
                  <Fragment key={tileKey}>
                  {i > 0 ? <SplitResizer left={split.tiles[i - 1]} right={tile} /> : null}
                  <div
                    className={`split-column${live ? ' live' : ''}`}
                    data-split-column={i}
                    style={{ flexGrow: splitWeights[tileKey] ?? 1 }}
                    onPointerDownCapture={live ? undefined : (e) => {
                      if ((e.target as HTMLElement).closest('[data-testid="split-peer"]')) return
                      focusSplitSession(tile, false)
                    }}
                  >
                    <Workspace sessionKey={columnKey} active={live} fit edges={{ left: i === 0 ? DOCK_GAP : DOCK_GAP / 2, right: i === split.tiles.length - 1 ? 2 : DOCK_GAP / 2 }}>
                      <WorkspacePane id={CHAT_PANE} title={t('split.paneTitle')} icon="chat-round" actions={[{ label: t('split.closeSide'), icon: 'close', run: () => closeSplitTile(i) }]}>
                        {live ? chatColumn : <SplitPeerPane index={i} target={tile} />}
                      </WorkspacePane>
                      <RightPanel sessionKey={columnKey} live={live} />
                    </Workspace>
                  </div>
                  </Fragment>
                )
              })}
            </div>
          ) : (
            <Workspace sessionKey={conversationKeyOf(session)}>
              <WorkspacePane id={CHAT_PANE} title="主会话" icon="chat-round">
                {chatColumn}
              </WorkspacePane>
              <RightPanel />
            </Workspace>
          )}
          <FloatingTiles />
          <SplitDropZone />
        </div>
        <StatusBar />
      </div>

      {wizard ? (
        <OnboardingWizard
          onClose={() => {
            markOnboarded()
            setWizard(false)
          }}
        />
      ) : null}

      {onboarding ? <Onboarding onClose={() => setOnboarding(false)} /> : null}

      <NativeSessionSurface />
      <UiDialog />
      <Notices />
      <SchedulePage open={scheduleOpen} onClose={() => setScheduleOpen(false)} />

      <Settings
        open={settingsOpen}
        tab={settingsTab}
        onClose={closeSettings}
        onTabChange={setSettingsTab}
        onShowShortcuts={() => {
          closeSettings()
          setSheetOpen(true)
        }}
        onShowOnboarding={() => {
          closeSettings()
          setOnboarding(true)
        }}
        onShowWizard={() => {
          closeSettings()
          setWizard(true)
        }}
      />
    </>
    </ConfirmProvider>
  )
}
