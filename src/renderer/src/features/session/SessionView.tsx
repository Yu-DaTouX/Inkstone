import { uiText } from '../../i18n/ui-text'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { VList, type VListHandle } from 'virtua'
import { useT } from '../../i18n'
import { streamingMessageId, useStore } from '../../state/store'
import { useThrottledValue } from '../../state/streaming-throttle'
import { createTurnProjector, type Turn } from '../../../../shared/turns'
import { mergeQuestionLog } from '../../../../shared/question-log'
import { TurnView } from './TurnView'
import { withoutWrapUpMessages } from './wrap-up'
import { AsideFitScope, ToolExpansionScope } from './use-tool-run'
import { toolExpansionScopeOf } from './tool-expansion'
import { PendingRunNotice } from './RunNotice'
import { OutlineRail, userTurnRenderIndex } from './OutlineRail'
import { HomeBackdrop } from '../ambient/HomeBackdrop'
import { asciiBackgroundEnabled } from '../ambient/ascii-field-model'
import { Button } from '../../ui'
import { motionAllowed } from '../../ui/motion-hooks'
import { ChevronDown } from '../../ui/icons'
import { sessionViewIdentity, viewMatchesProjectedSession } from './view-state'
import { useSessionViewSource, type SessionPaneBinding } from './session-view-source'
import { TurnScopeContext } from './turn-scope'
import { V3EmptyState } from './V3EmptyState'
import { PeerEmpty, SwitchSkeleton } from './SessionPlaceholders'
import { RewindDialogV3 } from './RewindDialogV3'
import {
  buildBranchPagerMap,
  loadPagerTree,
  navigatePagerBranch,
  pagerTreeCurrent,
  treeHasEntryId,
  type BranchPagerModel,
  type BranchPagerRequest
} from './branch-pager-model'
import { countUserMessages, mergeApprovalLogCached, withoutImageNotices } from './effective-messages'
import { decisionOutcomes, turnAnswers } from './turn-outcome'
import { messageEntrySignature } from './turn-lines'
import type { BranchPagerBinding } from './BranchPager'
import type { NativeTreeNode } from '../../../../shared/native-session'
import { MessageMenuHost } from './MessageMenu'
import { SessionFindBar, type VirtualFindSource } from './SessionFindBar'
import { turnFindText, type TurnFindText } from './session-find'
import { decideFollow, distanceFromBottom, isScrollIntentKey, JUMP_THRESHOLD_PX, SCROLL_INTENT_EVENT, userScrollActive, wheelReachesBottom, type FollowDecision, type ReadingAnchor, type ScrollMetrics } from './scroll-follow'
import { holdStreamTail } from './stream-tail-hold'
import { domAnchor, domMetrics, domReadingAnchors, glideSettle, keepSettleAnchor, resolveAnchorPoint, readScrollSnapshot, restoreDomScroll, saveScrollSnapshot, settleAnchor, settleShift, type SettleAnchor } from './scroll-position'
import { FLIGHT_FRAME_CAP_MS, FLIGHT_INSET_PX, FLIGHT_SETTLE_FRAMES, FLIGHT_SETTLE_STILL, flightPhase, flightTravel, landingIndices, planFlight, skipCruise } from './timeline-flight'
import './session.css'
import { readVirtualCache, saveVirtualCache, virtualizeSession } from './virtual-cache'
import { withSubmittingMessages } from '../../state/submitting-messages'
import { cssQuoted, highlightMessageElement, nextFrame, registerMessageLocator } from '../../state/message-locator'

const PAGER_TREE_DEBOUNCE_MS = 400

interface NativeSessionBridge {
  nativeSession?: BranchPagerRequest
}

function nativeSessionBridge(): BranchPagerRequest | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yan?: NativeSessionBridge }).yan?.nativeSession
}

const VIRTUAL_BUFFER_PX = 1600
const VIRTUAL_BUFFER_NARROW_PX = 400
const VIRTUAL_BUFFER_WIDEN_MS = 320
const VIRTUAL_ITEM_SIZE_PX = 240
const FOLLOW_RESUME_SLACK_PX = 96
const DISCLOSURE_SETTLE_MS = 280
const JUMP_LIVE_THRESHOLD_PX = 32
const FOLLOW_FRAME_CAP_MS = 50
const END_GLIDE_MS = 400
const LOCATE_MOUNT_FRAMES = 30
const NAV_FLASH_MS = 900
const NAV_MOUNT_FRAMES = 30

function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface Flight {
  skim: boolean
  real: Set<number>
}

interface FlightRequest {
  destination: () => number
  exact?: () => number | null
  landing?: () => number[]
  instant?: boolean
  arrive?: () => void
}

function jumpThreshold(running: boolean): number {
  return running ? JUMP_LIVE_THRESHOLD_PX : JUMP_THRESHOLD_PX
}

function followTau(gap: number): number {
  return gap > 400 ? 45 : gap > 120 ? 75 : 115
}

function pinBottom(box: HTMLElement): void {
  box.scrollTop = box.scrollHeight
}

function paintSkim(box: HTMLElement, enabled: boolean): boolean {
  const host = box.closest<HTMLElement>('.v3-stream-host')
  if (!enabled) {
    host?.removeAttribute('data-flight-skim')
    return false
  }
  const view = box.getBoundingClientRect()
  const visible = [...box.querySelectorAll<HTMLElement>('.v3-msg')].some((node) => {
    const rect = node.getBoundingClientRect()
    return rect.bottom > view.top && rect.top < view.bottom
  })
  host?.toggleAttribute('data-flight-skim', !visible)
  return !visible
}

function mountedRows(box: HTMLElement): Set<number> {
  const rows = new Set<number>()
  for (const node of box.querySelectorAll<HTMLElement>('.v3-stream-row[data-row]')) rows.add(Number(node.dataset.row))
  return rows
}

type PendingTurn = { kind: 'pending'; id: string }
type RenderItem = Turn | PendingTurn

const isPending = (item: RenderItem): item is PendingTurn => item.kind === 'pending'

const WIDTH_SETTLE_MS = 700

function virtualAnchor(handle: VListHandle, items: ReadonlyArray<RenderItem>): ReadingAnchor | null {
  const index = handle.findItemIndex(handle.scrollOffset)
  const item = items[index]
  if (!item) return null
  return { turnId: item.id, offset: Math.max(0, handle.scrollOffset - handle.getItemOffset(index)) }
}

const SKELETON_DELAY_MS = 180

export function SessionView({ pane }: { pane?: SessionPaneBinding } = {}): JSX.Element {
  const t = useT()
  const source = useSessionViewSource(pane)
  const { messages, session, questionLog, questionLogSession, approvalLog, approvalLogSession, runTail, peekedSessionId, peekedPath, settings, switchLoading, submittingMessages, readOnly, ownsSubmission } = source

  const baseView = useMemo(
    () => source.view ?? sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [source.view, peekedSessionId, peekedPath, session]
  )
  const view = useMemo(
    () => (source.scrollKey && source.scrollKey !== baseView.key ? { ...baseView, key: source.scrollKey } : baseView),
    [baseView, source.scrollKey]
  )
  const viewActive = !readOnly && viewMatchesProjectedSession(view, session)
  const viewPathSessionId = useStore((s) => (view.sessionId || !view.sessionFile ? null : (s.sessions.find((item) => toolExpansionScopeOf(null, item.path) === toolExpansionScopeOf(null, view.sessionFile))?.id ?? null)))
  const expansionScope = toolExpansionScopeOf(view.sessionId ?? viewPathSessionId, view.sessionFile)
  const rewindOwner = viewActive ? (session?.conversationId ?? session?.sessionId ?? null) : null

  const refreshCheckpoints = useStore((s) => s.refreshCheckpoints)
  const checkpointMessages = messages.length
  useEffect(() => {
    if (!viewActive) return undefined
    const timer = window.setTimeout(() => void refreshCheckpoints(), 400)
    return () => window.clearTimeout(timer)
  }, [viewActive, refreshCheckpoints, rewindOwner, checkpointMessages])

  const pagerSessionId = viewActive ? (session?.sessionId ?? null) : null
  const pagerBusy = viewActive && !!(session?.isAgentRunning || session?.isStreaming || session?.isCompacting)
  const entrySignature = useMemo(() => (pagerBusy ? '' : messageEntrySignature(messages)), [messages, pagerBusy])
  const [branchTree, setBranchTree] = useState<NativeTreeNode[] | null>(null)
  const [branchLeafId, setBranchLeafId] = useState<string | null>(null)
  const [branchPending, setBranchPending] = useState<string | null>(null)
  const [branchError, setBranchError] = useState('')
  const [branchReload, setBranchReload] = useState(0)
  const branchRunRef = useRef(0)
  const branchAliveRef = useRef(true)
  const branchTreeRef = useRef<NativeTreeNode[] | null>(null)
  branchTreeRef.current = branchTree
  const branchLeafRef = useRef<string | null>(null)
  branchLeafRef.current = branchLeafId
  const branchLoadedRef = useRef<{ sessionId: string; signature: string; reload: number } | null>(null)

  useEffect(() => {
    branchAliveRef.current = true
    return () => {
      branchAliveRef.current = false
      branchRunRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!pagerSessionId) {
      branchLoadedRef.current = null
      setBranchTree(null)
      setBranchLeafId(null)
      setBranchPending(null)
      setBranchError('')
      return undefined
    }
    if (pagerBusy) return undefined
    const loaded = branchLoadedRef.current
    if (loaded && loaded.sessionId === pagerSessionId && loaded.reload === branchReload && pagerTreeCurrent({ tree: branchTreeRef.current, leafId: branchLeafRef.current, loadedSignature: loaded.signature, signature: entrySignature })) {
      loaded.signature = entrySignature
      return undefined
    }
    const run = ++branchRunRef.current
    const timer = window.setTimeout(() => {
      const request = nativeSessionBridge()
      if (!request) {
        if (branchAliveRef.current && run === branchRunRef.current) {
          setBranchTree(null)
          setBranchLeafId(null)
        }
        return
      }
      void loadPagerTree(request, pagerSessionId, uiText('state.error.sessionTreeFailed')).then((result) => {
        if (!branchAliveRef.current || run !== branchRunRef.current) return
        if (!result.ok) {
          setBranchTree(null)
          setBranchLeafId(null)
          return
        }
        branchLoadedRef.current = { sessionId: pagerSessionId, signature: entrySignature, reload: branchReload }
        setBranchTree(result.tree)
        setBranchLeafId(result.leafId)
        setBranchError('')
      })
    }, PAGER_TREE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [pagerSessionId, pagerBusy, entrySignature, branchReload])

  const navigateBranchPager = useCallback(async (targetId: string): Promise<void> => {
    if (!pagerSessionId || branchPending !== null || pagerBusy) return
    if (useStore.getState().session?.sessionId !== pagerSessionId) return
    const tree = branchTreeRef.current
    if (!tree || !treeHasEntryId(tree, targetId)) {
      setBranchError(uiText('state.error.branchStale'))
      return
    }
    const request = nativeSessionBridge()
    if (!request) {
      setBranchError(uiText('state.error.nativeBridgeMissing'))
      return
    }
    setBranchPending(targetId)
    setBranchError('')
    if (useStore.getState().pendingActivation) {
      const activated = await useStore.getState().ensureActivated()
      if (!branchAliveRef.current) return
      if (!activated || useStore.getState().session?.sessionId !== pagerSessionId) {
        setBranchPending(null)
        return
      }
    }
    const result = await navigatePagerBranch(request, pagerSessionId, targetId, uiText('state.error.branchSwitchFailed'))
    if (!branchAliveRef.current) return
    setBranchPending(null)
    if (useStore.getState().session?.sessionId !== pagerSessionId) return
    if (!result.ok) {
      setBranchError(result.error || uiText('state.error.branchSwitchFailed'))
      return
    }
    await useStore.getState().refreshSessions()
    if (!branchAliveRef.current || useStore.getState().session?.sessionId !== pagerSessionId) return
    setBranchReload((value) => value + 1)
  }, [pagerSessionId, branchPending, pagerBusy])

  const branchPagerModels = useMemo(
    () => (branchTree ? buildBranchPagerMap(branchTree, branchLeafId) : new Map<string, BranchPagerModel>()),
    [branchTree, branchLeafId]
  )
  const branchPager = useMemo<BranchPagerBinding | undefined>(() => {
    if (!pagerSessionId) return undefined
    return {
      models: branchPagerModels,
      pending: branchPending,
      error: branchError,
      disabled: pagerBusy,
      onNavigate: (targetId: string) => {
        void navigateBranchPager(targetId)
      }
    }
  }, [pagerSessionId, branchPagerModels, branchPending, branchError, pagerBusy, navigateBranchPager])

  const projectTurns = useMemo(() => createTurnProjector(), [])
  const streamingId = readOnly ? source.streamingId : viewActive ? streamingMessageId({ session, messages, runTail }) : undefined
  const effectiveMessages = useMemo(
    () => mergeApprovalLogCached(
      mergeQuestionLog(withSubmittingMessages(messages, submittingMessages.filter((item) => ownsSubmission(item.identity))), questionLogSession && questionLogSession === view.sessionId ? questionLog : []),
      approvalLogSession && approvalLogSession === view.sessionId ? approvalLog : []
    ),
    [messages, submittingMessages, ownsSubmission, questionLog, questionLogSession, approvalLog, approvalLogSession, view.key, session]
  )
  const visibleMessages = useMemo(() => withoutImageNotices(effectiveMessages), [effectiveMessages])
  const projectedMessages = useMemo(() => withoutWrapUpMessages(visibleMessages), [visibleMessages])
  const turns = useMemo(() => projectTurns(projectedMessages, streamingId), [projectedMessages, streamingId, projectTurns])
  const answers = useMemo(() => turnAnswers(turns), [turns])
  const outcomes = useMemo(() => decisionOutcomes(turns), [turns])

  const awaitingReply = viewActive && turns.length > 0 && turns[turns.length - 1].kind !== 'assistant' && !!(session?.isAgentRunning || session?.isStreaming)
  const renderTurns = useMemo<RenderItem[]>(
    () => awaitingReply ? [...turns, { kind: 'pending' as const, id: '__pending__' }] : turns,
    [turns, awaitingReply]
  )
  const keyAliasRef = useRef<{ identity: string; aliases: Map<string, string>; submitting: Map<string, string>; seen: Set<string> } | null>(null)
  const turnKey = useMemo(() => {
    const state = keyAliasRef.current?.identity === view.key ? keyAliasRef.current : { identity: view.key, aliases: new Map<string, string>(), submitting: new Map<string, string>(), seen: new Set<string>() }
    keyAliasRef.current = state
    const submitting = new Map<string, string>()
    for (const item of renderTurns) {
      if (isPending(item) || item.kind !== 'user') continue
      const text = item.msg.text
      if (item.id.startsWith('submitting-')) submitting.set(text, item.id)
      else if (!state.seen.has(item.id)) {
        const from = state.submitting.get(text)
        if (from && !submitting.has(text)) state.aliases.set(item.id, from)
      }
      state.seen.add(item.id)
    }
    state.submitting = submitting
    return (id: string): string => state.aliases.get(id) ?? id
  }, [renderTurns, view.key])
  const virtualModeRef = useRef({ identity: view.key, active: false })
  const virtual = virtualizeSession(virtualModeRef.current.identity === view.key && virtualModeRef.current.active, turns.length, messages.length)
  virtualModeRef.current = { identity: view.key, active: virtual }
  const tailRunning = viewActive && !!(session?.isAgentRunning || session?.isStreaming)
  const tailRunningRef = useRef(tailRunning)
  tailRunningRef.current = tailRunning
  const followRunRef = useRef({ identity: view.key, running: tailRunning, endedAt: 0 })
  if (followRunRef.current.identity !== view.key) followRunRef.current = { identity: view.key, running: tailRunning, endedAt: 0 }
  if (followRunRef.current.running && !tailRunning) followRunRef.current.endedAt = performance.now()
  followRunRef.current.running = tailRunning

  const identity = view.key
  const [stick, setStick] = useState(true)
  const [showJump, setShowJump] = useState(false)
  const stickRef = useRef(true)
  const emptyRef = useRef(false)
  const intentRef = useRef<number | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const asideProbeRef = useRef<HTMLDivElement | null>(null)
  const [asideFits, setAsideFits] = useState(false)
  const vlistRef = useRef<VListHandle>(null)
  const settlingRef = useRef(false)
  const cancelNavigationRef = useRef<() => void>(() => undefined)
  const flightRef = useRef<Flight | null>(null)
  const [keepMounted, setKeepMounted] = useState<readonly number[] | undefined>(undefined)
  const [flying, setFlying] = useState(false)
  const [wideBuffer, setWideBuffer] = useState(false)
  const renderTurnsRef = useRef(renderTurns)
  renderTurnsRef.current = renderTurns
  const measurementRun = useMemo(() => ({ items: renderTurns }), [identity, virtual])
  measurementRun.items = renderTurns
  const userIndices = useMemo(() => {
    let userIndex = -1
    return renderTurns.map((turn) => {
      if (turn.kind === 'user') userIndex++
      return userIndex
    })
  }, [renderTurns])
  const userIndicesRef = useRef(userIndices)
  userIndicesRef.current = userIndices
  const readActiveIndex = useCallback((): number | undefined => {
    const handle = vlistRef.current
    if (!handle) return undefined
    const indices = userIndicesRef.current
    const offset = handle.scrollOffset
    if (handle.scrollSize - offset - handle.viewportSize < 4) return indices.at(-1) ?? -1
    const index = handle.findItemIndex(offset + Math.min(handle.viewportSize * .25, 120))
    return Math.max(0, indices[index] ?? -1)
  }, [])
  const readRange = useCallback((): { first: number; last: number } | undefined => {
    const handle = vlistRef.current
    const indices = userIndicesRef.current
    if (!handle || !indices.length) return undefined
    const top = handle.findItemIndex(handle.scrollOffset)
    const bottom = Math.min(indices.length - 1, handle.findItemIndex(handle.scrollOffset + handle.viewportSize))
    return { first: Math.max(0, indices[top] ?? 0), last: Math.max(0, indices[bottom] ?? 0) }
  }, [])
  const [remountKey, setRemountKey] = useState(0)
  const measurementCache = useMemo(() => {
    if (!virtual) return undefined
    const width = hostRef.current?.querySelector<HTMLElement>('.v3-stream')?.clientWidth ?? hostRef.current?.clientWidth ?? 0
    return readVirtualCache(identity, measurementRun.items.map((item) => item.id), width)
  }, [identity, virtual, remountKey])
  useLayoutEffect(() => {
    const handle = vlistRef.current
    const box = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    if (!virtual || !handle || !box) return undefined
    const width = box.clientWidth
    return () => saveVirtualCache(identity, measurementRun.items.map((item) => item.id), box.clientWidth || width, handle.cache)
  }, [identity, virtual, remountKey, switchLoading])
  const arriveStage = `${identity}|${switchLoading ? 'l' : 'r'}`
  const [seenStage, setSeenStage] = useState(arriveStage)
  const [arriveFlip, setArriveFlip] = useState(0)
  const skeletonSince = useRef(0)
  if (switchLoading && messages.length === 0) {
    if (skeletonSince.current === 0) skeletonSince.current = performance.now()
  } else if (!switchLoading && skeletonSince.current > 0) {
    if (performance.now() - skeletonSince.current >= SKELETON_DELAY_MS && motionAllowed() && seenStage !== arriveStage) setArriveFlip((flip) => flip + 1)
    skeletonSince.current = 0
  } else if (messages.length > 0) {
    skeletonSince.current = 0
  }
  if (seenStage !== arriveStage) setSeenStage(arriveStage)
  const remountsRef = useRef(0)
  const settleRef = useRef<SettleAnchor | null>(null)
  const streamingSeenRef = useRef({ identity, streamingId, tailRunning })
  if (streamingSeenRef.current.identity !== identity || streamingSeenRef.current.streamingId !== streamingId || streamingSeenRef.current.tailRunning !== tailRunning) {
    const seen = streamingSeenRef.current
    const settleBox = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    if (seen.identity === identity && (seen.streamingId && !streamingId || seen.tailRunning && !tailRunning) && settleBox) settleRef.current = settleAnchor(settleBox, stickRef.current)
    streamingSeenRef.current = { identity, streamingId, tailRunning }
  }

  useLayoutEffect(() => {
    const anchor = settleRef.current
    const box = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    settleRef.current = null
    if (!anchor || !box) return undefined
    if (stickRef.current) {
      if (!userScrollActive(intentRef.current, performance.now())) box.scrollTop = box.scrollHeight
      glideSettle(anchor, settleShift(box, anchor))
      return undefined
    }
    keepSettleAnchor(box, anchor)
    glideSettle(anchor, settleShift(box, anchor))
    const settled = box.scrollTop
    const raf = requestAnimationFrame(() => {
      if (stickRef.current || Math.abs(box.scrollTop - settled) > 1) return
      keepSettleAnchor(box, anchor)
    })
    return () => cancelAnimationFrame(raf)
  }, [streamingId, tailRunning])

  const followGlideRef = useRef(0)
  const followBottom = useCallback((box: HTMLElement, instant = false) => {
    if (instant || !tailRunningRef.current && performance.now() - followRunRef.current.endedAt > END_GLIDE_MS || prefersReducedMotion()) {
      cancelAnimationFrame(followGlideRef.current)
      followGlideRef.current = 0
      pinBottom(box)
      return
    }
    if (followGlideRef.current) return
    let last = performance.now()
    const step = (now: number): void => {
      followGlideRef.current = 0
      if (!stickRef.current || settlingRef.current || !box.isConnected) return
      const gap = box.scrollHeight - box.clientHeight - box.scrollTop
      if (gap <= 0.5) return
      const dt = Math.min(FOLLOW_FRAME_CAP_MS, Math.max(0, now - last))
      last = now
      box.scrollTop += Math.min(gap, Math.max(1, gap * (1 - Math.exp(-dt / followTau(gap)))))
      followGlideRef.current = requestAnimationFrame(step)
    }
    followGlideRef.current = requestAnimationFrame(step)
  }, [])

  const setStickNow = useCallback((value: boolean) => {
    stickRef.current = value
    setStick(value)
  }, [])

  const record = useCallback((top: number, bottom: boolean, anchor: ReadingAnchor | null) => {
    saveScrollSnapshot(identity, { top, bottom, anchor })
  }, [identity])

  const widthRef = useRef(0)
  const recordRef = useRef(record)
  recordRef.current = record
  const readingRef = useRef<ReadingAnchor | null>(null)
  const widthWindowRef = useRef<{ until: number; anchor: ReadingAnchor | null } | null>(null)

  const applyFollow = useCallback((decision: FollowDecision) => {
    if (stickRef.current !== decision.stick) setStickNow(decision.stick)
    setShowJump(decision.showJump)
  }, [setStickNow])

  const scrollFrameRef = useRef(0)
  const virtualRecordTimerRef = useRef(0)
  const manualSkimFrameRef = useRef(0)
  const lastVirtualOffsetRef = useRef(0)
  const lastMetricsRef = useRef<ScrollMetrics | null>(null)
  const readScroll = useCallback(() => {
    const el = streamRef.current
    if (!el) return
    const metrics = domMetrics(el)
    const decision = decideFollow(stickRef.current, metrics, intentRef.current, performance.now(), lastMetricsRef.current, jumpThreshold(tailRunningRef.current))
    lastMetricsRef.current = metrics
    applyFollow(decision)
    if (decision.repin) followBottom(el)
    const anchors = decision.stick ? null : domReadingAnchors(el)
    readingRef.current = anchors?.resize ?? null
    record(el.scrollTop, decision.stick, anchors?.snapshot ?? null)
  }, [applyFollow, record, followBottom])

  const onScroll = useCallback(() => {
    if (scrollFrameRef.current) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      if (settlingRef.current) return
      readScroll()
    })
  }, [readScroll])

  useEffect(() => () => {
    cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = 0
    cancelAnimationFrame(followGlideRef.current)
    followGlideRef.current = 0
    clearTimeout(virtualRecordTimerRef.current)
    virtualRecordTimerRef.current = 0
    cancelAnimationFrame(manualSkimFrameRef.current)
    manualSkimFrameRef.current = 0
    lastVirtualOffsetRef.current = 0
    hostRef.current?.removeAttribute('data-flight-skim')
  }, [identity, virtual])

  const readVirtualScroll = useCallback(() => {
    const h = vlistRef.current
    if (!h || settlingRef.current) return
    const metrics = { offset: h.scrollOffset, size: h.scrollSize, viewport: h.viewportSize }
    const decision = decideFollow(stickRef.current, metrics, intentRef.current, performance.now(), lastMetricsRef.current, jumpThreshold(tailRunningRef.current))
    lastMetricsRef.current = metrics
    applyFollow(decision)
    const root = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    if (decision.repin && root) followBottom(root)
    record(h.scrollOffset, decision.stick, decision.stick ? null : virtualAnchor(h, renderTurnsRef.current))
    clearTimeout(virtualRecordTimerRef.current)
    if (!decision.stick) virtualRecordTimerRef.current = window.setTimeout(() => {
      virtualRecordTimerRef.current = 0
      const handle = vlistRef.current
      const root = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
      if (!handle || !root || settlingRef.current || stickRef.current) return
      record(handle.scrollOffset, false, domAnchor(root) ?? virtualAnchor(handle, renderTurnsRef.current))
    }, 120)
  }, [record, applyFollow, followBottom])

  const onVirtualScroll = useCallback(() => {
    if (scrollFrameRef.current) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      readVirtualScroll()
      const box = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
      if (!box) return
      const distance = Math.abs(box.scrollTop - lastVirtualOffsetRef.current)
      lastVirtualOffsetRef.current = box.scrollTop
      if (flightRef.current || stickRef.current || distance < box.clientHeight) return
      cancelAnimationFrame(manualSkimFrameRef.current)
      const sync = (): void => {
        manualSkimFrameRef.current = 0
        if (!box.isConnected || flightRef.current) return
        if (paintSkim(box, true)) manualSkimFrameRef.current = requestAnimationFrame(sync)
      }
      sync()
    })
  }, [readVirtualScroll])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const mark = (): void => {
      cancelNavigationRef.current()
      intentRef.current = performance.now()
      if (stickRef.current) setStickNow(false)
    }
    const wheel = (event: WheelEvent): void => {
      const handle = vlistRef.current
      const metrics = handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
      if (event.deltaY < 0 && metrics && metrics.size <= metrics.viewport + 1) return
      if (metrics && wheelReachesBottom(metrics, event.deltaY, event.deltaMode)) {
        cancelNavigationRef.current()
        intentRef.current = null
        setStickNow(true)
      } else mark()
    }
    const togglesDisclosure = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[aria-expanded]')
    const currentMetrics = (): ScrollMetrics | null => {
      const handle = vlistRef.current
      return handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
    }
    const resumeIfNear = (): void => {
      const metrics = currentMetrics()
      if (!metrics || stickRef.current || distanceFromBottom(metrics) > FOLLOW_RESUME_SLACK_PX) return
      intentRef.current = null
      setStickNow(true)
    }
    let disclosureTimer = 0
    let pressedWhileStuck = false
    const holdForDisclosure = (): void => {
      cancelNavigationRef.current()
      if (!stickRef.current) return
      setStickNow(false)
      window.clearTimeout(disclosureTimer)
      disclosureTimer = window.setTimeout(resumeIfNear, DISCLOSURE_SETTLE_MS)
    }
    const onPointerDown = (event: PointerEvent): void => {
      pressedWhileStuck = false
      if (togglesDisclosure(event.target)) return holdForDisclosure()
      if (event.target instanceof Element && event.target.closest('a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]')) return
      pressedWhileStuck = stickRef.current && event.target instanceof Element && !!event.target.closest('.v3-msg')
      mark()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('.v3-rail')) return
      if ((event.key === 'Enter' || event.key === ' ') && togglesDisclosure(event.target)) holdForDisclosure()
      else if (isScrollIntentKey(event.key)) mark()
    }
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.v3-stream') || !target.matches(':focus-visible')) return
      cancelNavigationRef.current()
      if (stickRef.current) setStickNow(false)
    }
    const release = (event: PointerEvent): void => {
      const plainClick = pressedWhileStuck && (window.getSelection()?.isCollapsed ?? true)
      pressedWhileStuck = false
      if (togglesDisclosure(event.target)) return
      if (plainClick) return resumeIfNear()
      const metrics = currentMetrics()
      if (!metrics || stickRef.current || distanceFromBottom(metrics) > 1) return
      intentRef.current = performance.now()
      setStickNow(true)
    }
    const options: AddEventListenerOptions = { passive: true, capture: true }
    host.addEventListener('wheel', wheel, options)
    host.addEventListener('touchmove', mark, options)
    host.addEventListener('pointerdown', onPointerDown, options)
    host.addEventListener('pointerup', release, options)
    host.addEventListener('keydown', onKey, options)
    host.addEventListener('focusin', onFocusIn, options)
    host.addEventListener(SCROLL_INTENT_EVENT, mark, options)
    return () => {
      window.clearTimeout(disclosureTimer)
      host.removeEventListener('wheel', wheel, options)
      host.removeEventListener('touchmove', mark, options)
      host.removeEventListener('pointerdown', onPointerDown, options)
      host.removeEventListener('pointerup', release, options)
      host.removeEventListener('keydown', onKey, options)
      host.removeEventListener('focusin', onFocusIn, options)
      host.removeEventListener(SCROLL_INTENT_EVENT, mark, options)
    }
  }, [setStickNow])

  const setStreamNode = useCallback((node: HTMLDivElement | null) => {
    streamRef.current = node
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    const inner = node.firstElementChild
    if (!inner) return
    widthRef.current = node.clientWidth
    const observer = new ResizeObserver(() => {
      if (settlingRef.current) return
      const width = node.clientWidth
      const narrowed = widthRef.current > 0 && Math.abs(width - widthRef.current) > 0.5
      widthRef.current = width
      if (stickRef.current) {
        if (emptyRef.current) return
        followBottom(node, narrowed)
        return
      }
      setShowJump(distanceFromBottom(domMetrics(node)) > jumpThreshold(tailRunningRef.current))
      const now = performance.now()
      const open = widthWindowRef.current
      if (narrowed) widthWindowRef.current = { until: now + WIDTH_SETTLE_MS, anchor: open && now <= open.until ? open.anchor : readingRef.current }
      const hold = widthWindowRef.current
      if (!hold || now > hold.until) return
      const anchor = hold.anchor
      if (!anchor) return
      const restore = (): void => {
        if (stickRef.current || settlingRef.current) return
        if (userScrollActive(intentRef.current, performance.now())) return
        const target = [...node.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].find((el) => el.dataset.turnId === anchor.turnId)
        if (!target) return
        const point = resolveAnchorPoint(target, anchor)
        const offset = point === null ? target.getBoundingClientRect().top - node.getBoundingClientRect().top : point - node.getBoundingClientRect().top
        const wanted = point === null ? anchor.offset : 0
        const max = Math.max(0, node.scrollHeight - node.clientHeight)
        const next = Math.min(Math.max(0, node.scrollTop + offset - wanted), max)
        const shift = next - node.scrollTop
        if (Math.abs(offset - wanted - shift) > 4) return
        if (Math.abs(shift) < 0.5) return
        node.scrollTop = next
        recordRef.current(next, false, point === null ? { turnId: anchor.turnId, offset: anchor.offset } : anchor)
      }
      restore()
    })
    observer.observe(inner, { box: 'border-box' })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  useLayoutEffect(() => {
    const probe = asideProbeRef.current
    if (!probe) return undefined
    const check = (): void => setAsideFits(probe.getBoundingClientRect().width > 0.5)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [])

  const empty = !virtual && turns.length === 0 && !switchLoading
  emptyRef.current = empty

  useLayoutEffect(() => {
    const chat = empty && !readOnly ? hostRef.current?.closest<HTMLElement>('.v3-chat') : null
    if (!chat) return undefined
    chat.dataset.empty = ''
    return () => {
      delete chat.dataset.empty
    }
  }, [empty, readOnly])

  useLayoutEffect(() => {
    if (!identity || switchLoading) return undefined
    const snap = readScrollSnapshot(identity)
    const bottom = !snap || snap.bottom
    stickRef.current = bottom
    setStick(bottom)
    setShowJump(false)
    intentRef.current = null
    settlingRef.current = true
    let settleRaf = 0
    const virtualRoot = (): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>('.v3-stream') ?? null
    const openAtBottom = (): void => {
      const root = virtualRoot()
      if (tailRunningRef.current) {
        if (root) pinBottom(root)
      } else vlistRef.current?.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
    }
    if (virtual && bottom) openAtBottom()
    const raf = requestAnimationFrame(() => {
      const anchor = snap?.anchor ?? null
      if (virtual) {
        const handle = vlistRef.current
        const root = virtualRoot()
        const index = anchor ? renderTurnsRef.current.findIndex((item) => item.id === anchor.turnId) : -1
        if (bottom) {
          if (handle && handle.scrollSize - handle.scrollOffset - handle.viewportSize > 1) openAtBottom()
        } else if (anchor && index >= 0 && handle && root) root.scrollTop = Math.max(0, handle.getItemOffset(index) + anchor.offset)
        else if (snap && root) root.scrollTop = snap.top
        if (!bottom && handle) setShowJump(distanceFromBottom({ offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize }) > jumpThreshold(tailRunningRef.current))
      } else if (streamRef.current) {
        const box = streamRef.current
        if (emptyRef.current) box.scrollTop = 0
        else restoreDomScroll(box, snap)
        if (!bottom) setShowJump(distanceFromBottom(domMetrics(box)) > jumpThreshold(tailRunningRef.current))
      }
      if (virtual && !bottom && snap) {
        const started = performance.now()
        let frames = 0
        let stable = 0
        const restore = (): void => {
          if (userScrollActive(intentRef.current, performance.now())) {
            settlingRef.current = false
            return
          }
          const box = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
          if (box) {
            const previous = box.scrollTop
            restoreDomScroll(box, snap)
            const shift = Math.abs(previous - box.scrollTop)
            stable = shift <= .5 ? stable + 1 : 0
          }
          const elapsed = performance.now() - started
          if (++frames >= 60 || elapsed > 600 || stable >= 3 && elapsed >= 160) settlingRef.current = false
          else settleRaf = requestAnimationFrame(restore)
        }
        settleRaf = requestAnimationFrame(restore)
      } else settlingRef.current = false
    })
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(settleRaf)
    }
  }, [identity, virtual, remountKey, switchLoading])

  useEffect(() => { remountsRef.current = 0 }, [identity])

  const tailId = renderTurns.at(-1)?.id
  useLayoutEffect(() => {
    const scroller = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    if (!tailRunning || !scroller) return undefined
    return holdStreamTail(scroller, () => scroller.querySelector<HTMLElement>(virtual ? '.v3-stream-row--tail' : '.v3-stream-inner'))
  }, [tailRunning, virtual, identity, remountKey, tailId])

  useEffect(() => {
    if (!virtual) return undefined
    const root = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
    if (!root) return undefined
    let width = root.clientWidth
    const repin = (): void => {
      const resized = Math.abs(root.clientWidth - width) > 0.5
      width = root.clientWidth
      if (settlingRef.current || !stickRef.current) return
      followBottom(root, resized)
    }
    const observer = new ResizeObserver(repin)
    observer.observe(root)
    if (root.firstElementChild) observer.observe(root.firstElementChild)
    return () => observer.disconnect()
  }, [virtual, identity, remountKey])

  useEffect(() => {
    if (settlingRef.current) return undefined
    if (!stickRef.current) {
      const measure = (): void => {
        if (stickRef.current) return
        const handle = vlistRef.current
        const metrics = virtual && handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
        if (metrics) setShowJump(distanceFromBottom(metrics) > jumpThreshold(tailRunningRef.current))
      }
      measure()
      let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(measure) })
      return () => cancelAnimationFrame(raf)
    }
    if (userScrollActive(intentRef.current, performance.now())) return undefined
    if (virtual) {
      const root = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
      if (root) followBottom(root)
      return undefined
    }
    const el = streamRef.current
    if (el && emptyRef.current) el.scrollTop = 0
    else if (el) followBottom(el)
    return undefined
  }, [renderTurns, stick, virtual, followBottom])

  useEffect(() => {
    if (!virtual) return undefined
    let frames = 0
    let raf = 0
    const tick = (): void => {
      const root = (virtual ? hostRef.current?.querySelector('.v3-stream') : streamRef.current) as HTMLElement | null
      const blank = !!root && root.clientHeight > 0 && root.scrollHeight <= root.clientHeight + 1 && renderTurnsRef.current.length > 0
      if (blank && remountsRef.current < 3) {
        const handle = vlistRef.current
        if (handle && root) saveVirtualCache(identity, renderTurnsRef.current.map((item) => item.id), root.clientWidth, handle.cache)
        remountsRef.current += 1
        setRemountKey((k) => k + 1)
        return
      }
      if (++frames < 20) { raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [virtual, identity, remountKey])

  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const outlineMessages = useThrottledValue(visibleMessages, !!streamingId)

  const navRef = useRef<number | null>(null)
  const landingReleaseRef = useRef(0)
  const flashRef = useRef<{ timer: number; el: HTMLElement | null }>({ timer: 0, el: null })

  const turnNode = useCallback((turnId: string): HTMLElement | null =>
    hostRef.current?.querySelector<HTMLElement>(`.v3-msg[data-turn-id="${cssQuoted(turnId)}"]`) ?? null, [])

  const flashTurn = useCallback((el: HTMLElement) => {
    const prev = flashRef.current
    if (prev.timer) window.clearTimeout(prev.timer)
    prev.el?.classList.remove('v3-msg-nav')
    el.classList.remove('v3-msg-nav')
    el.getBoundingClientRect()
    el.classList.add('v3-msg-nav')
    const timer = window.setTimeout(() => {
      el.classList.remove('v3-msg-nav')
      flashRef.current = { timer: 0, el: null }
    }, NAV_FLASH_MS)
    flashRef.current = { timer, el }
  }, [])

  const endNavigation = useCallback((retainLanding = false) => {
    window.clearTimeout(landingReleaseRef.current)
    landingReleaseRef.current = 0
    const frame = navRef.current
    navRef.current = null
    if (frame !== null) cancelAnimationFrame(frame)
    settlingRef.current = false
    flightRef.current = null
    hostRef.current?.removeAttribute('data-flight-skim')
    if (retainLanding) landingReleaseRef.current = window.setTimeout(() => {
      landingReleaseRef.current = 0
      setKeepMounted(undefined)
    }, VIRTUAL_BUFFER_WIDEN_MS)
    else setKeepMounted(undefined)
    setFlying(false)
  }, [])
  cancelNavigationRef.current = endNavigation

  const scrollBox = useCallback((): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>('.v3-stream') ?? null, [])

  const revealTurn = useCallback((turnId: string) => {
    let frames = 0
    const reveal = (): void => {
      const el = turnNode(turnId)
      if (el) {
        flashTurn(el)
        return
      }
      if (++frames < NAV_MOUNT_FRAMES) requestAnimationFrame(reveal)
    }
    reveal()
  }, [flashTurn, turnNode])

  const fly = useCallback((request: FlightRequest) => {
    endNavigation()
    const box = scrollBox()
    if (!box) return
    settlingRef.current = true
    const flight: Flight = { skim: false, real: new Set() }
    flightRef.current = flight
    setFlying(true)
    let origin = box.scrollTop
    let written = origin
    let elapsed = 0
    let last = performance.now()
    let prepared = false
    let landing: number[] = []
    let frames = 0
    let still = 0
    const first = request.destination()
    const direction = Math.sign(first - origin) || 1
    const plan = planFlight(Math.abs(first - origin), box.clientHeight)
    const instant = !!request.instant || prefersReducedMotion() || plan.duration === 0
    const write = (top: number): void => {
      const next = Math.min(Math.max(0, box.scrollHeight - box.clientHeight), Math.max(0, top))
      if (Math.abs(next - box.scrollTop) > 0.25) box.scrollTo({ top: next, behavior: 'instant' })
      written = box.scrollTop
      if (flight.skim) paintSkim(box, true)
    }
    const prepare = (): void => {
      if (prepared) return
      prepared = true
      landing = request.landing?.() ?? []
      if (!landing.length) return
      flight.real = mountedRows(box)
      for (const index of landing) flight.real.add(index)
      setKeepMounted(landing)
    }
    const finish = (): void => {
      endNavigation(true)
      if (virtual) onVirtualScroll()
      else readScroll()
      request.arrive?.()
    }
    const settle = (): void => {
      if (flightRef.current !== flight) return
      const exact = request.exact?.() ?? null
      const before = box.scrollTop
      write(exact ?? request.destination())
      still = exact !== null && Math.abs(box.scrollTop - before) < 0.5 ? still + 1 : 0
      if (still >= FLIGHT_SETTLE_STILL || ++frames >= FLIGHT_SETTLE_FRAMES) {
        finish()
        return
      }
      navRef.current = requestAnimationFrame(settle)
    }
    const step = (now: number): void => {
      if (flightRef.current !== flight) return
      elapsed += Math.min(FLIGHT_FRAME_CAP_MS, Math.max(0, now - last))
      last = now
      const drift = box.scrollTop - written
      if (Math.abs(drift) > 0.5) origin += drift
      if (virtual && flightPhase(plan, elapsed) === 'cruise') elapsed = skipCruise(plan, elapsed, request.exact?.() != null)
      const phase = flightPhase(plan, elapsed)
      if (phase !== 'lead' && plan.far && landing.length && !flight.skim) {
        flight.skim = true
        setKeepMounted([...landing])
      }
      if (phase === 'done') {
        settle()
        return
      }
      const destination = request.destination()
      const way = Math.sign(destination - origin) || direction
      write(origin + way * flightTravel(plan, elapsed, Math.abs(destination - origin)))
      navRef.current = requestAnimationFrame(step)
    }
    prepare()
    if (instant) {
      write(first)
      navRef.current = requestAnimationFrame(settle)
      return
    }
    navRef.current = requestAnimationFrame(step)
  }, [endNavigation, scrollBox, virtual, onVirtualScroll, readScroll])

  const flyToRow = useCallback((index: number, turnId: string, align: 'start' | 'center', options: { instant?: boolean; arrive?: () => void } = {}) => {
    const box = scrollBox()
    if (!box) return
    const handle = virtual ? vlistRef.current : null
    const limit = (top: number): number => Math.min(Math.max(0, box.scrollHeight - box.clientHeight), Math.max(0, top))
    const lead = (height: number, viewport: number): number => align === 'center' ? Math.max(FLIGHT_INSET_PX, (viewport - height) / 2) : FLIGHT_INSET_PX
    const exact = (): number | null => {
      const el = turnNode(turnId)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return limit(rect.top - box.getBoundingClientRect().top + box.scrollTop - lead(rect.height, box.clientHeight))
    }
    const destination = (): number => {
      const top = exact()
      if (top !== null || !handle) return top ?? box.scrollTop
      return limit(handle.getItemOffset(index) - lead(handle.getItemSize(index), handle.viewportSize))
    }
    const landing = handle
      ? (): number[] => {
          const top = destination()
          const around: number[] = []
          const from = handle.findItemIndex(Math.max(0, top - handle.viewportSize * 0.6))
          const to = handle.findItemIndex(top + handle.viewportSize * 1.6)
          for (let row = from; row <= to; row += 1) around.push(row)
          return landingIndices(index, around, renderTurnsRef.current.length)
        }
      : undefined
    fly({ destination, exact, landing, instant: options.instant, arrive: options.arrive ?? (() => revealTurn(turnId)) })
  }, [fly, scrollBox, turnNode, revealTurn, virtual])

  useEffect(() => () => {
    endNavigation()
    const flash = flashRef.current
    if (flash.timer) window.clearTimeout(flash.timer)
    flash.el?.classList.remove('v3-msg-nav')
    flashRef.current = { timer: 0, el: null }
  }, [endNavigation, identity])

  const jumpToTurn = useCallback((userIndex: number) => {
    const list = turnsRef.current
    const target = userTurnRenderIndex(list, userIndex)
    const turn = target === undefined ? undefined : list[target]
    if (target === undefined || !turn) return
    setStickNow(false)
    flyToRow(target, turn.id, 'start')
  }, [setStickNow, flyToRow])

  useEffect(() => readOnly ? undefined : registerMessageLocator(async (messageId) => {
    const items = renderTurnsRef.current
    const index = items.findIndex((item) => !isPending(item) && (item.id === messageId || (item.kind === 'assistant' && item.sourceIds.includes(messageId))))
    if (index < 0) return false
    setStickNow(false)
    await new Promise<void>((arrived) => flyToRow(index, items[index].id, 'center', { arrive: arrived }))
    const selector = `[data-msg-id="${cssQuoted(messageId)}"], .v3-msg[data-turn-id="${cssQuoted(items[index].id)}"]`
    for (let frame = 0; frame < LOCATE_MOUNT_FRAMES; frame++) {
      const el = hostRef.current?.querySelector(selector)
      if (el) {
        highlightMessageElement(el)
        return true
      }
      await nextFrame()
    }
    return false
  }), [flyToRow, setStickNow, readOnly])

  const findScope = useCallback((): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>('.v3-stream') ?? null, [])

  const findTextsRef = useRef<{ items: RenderItem[]; texts: TurnFindText[] } | null>(null)
  const findSource = useMemo<VirtualFindSource>(() => ({
    texts: () => {
      const items = renderTurnsRef.current
      const cached = findTextsRef.current
      if (cached?.items === items) return cached.texts
      const texts = items.map((item) => ({ id: item.id, text: isPending(item) ? '' : turnFindText(item) }))
      findTextsRef.current = { items, texts }
      return texts
    },
    firstVisible: () => {
      const handle = vlistRef.current
      return handle ? handle.findItemIndex(handle.scrollOffset) : 0
    },
    turnElement: (turnId) => turnNode(turnId),
    mount: async (index) => {
      const item = renderTurnsRef.current[index]
      if (!item || !vlistRef.current) return null
      intentRef.current = performance.now()
      setStickNow(false)
      await new Promise<void>((arrived) => flyToRow(index, item.id, 'start', { instant: true, arrive: arrived }))
      for (let frame = 0; frame < LOCATE_MOUNT_FRAMES; frame++) {
        const el = turnNode(item.id)
        if (el) return el
        await nextFrame()
      }
      return null
    }
  }), [setStickNow, turnNode, flyToRow])

  const jumpToBottom = useCallback(() => {
    setStickNow(true)
    setShowJump(false)
    intentRef.current = null
    const box = scrollBox()
    if (!box) return
    const bottom = (): number => Math.max(0, box.scrollHeight - box.clientHeight)
    const landing = virtual
      ? (): number[] => {
          const count = renderTurnsRef.current.length
          return landingIndices(count - 1, [count - 2, count - 3], count)
        }
      : undefined
    fly({ destination: bottom, exact: bottom, landing, arrive: () => pinBottom(box) })
  }, [setStickNow, scrollBox, fly, virtual])

  const narrowBuffer = flying || (stick && tailRunning)
  useEffect(() => {
    if (narrowBuffer) {
      setWideBuffer(false)
      return undefined
    }
    const timer = window.setTimeout(() => setWideBuffer(true), VIRTUAL_BUFFER_WIDEN_MS)
    return () => window.clearTimeout(timer)
  }, [narrowBuffer, identity])

  const userCount = useMemo(() => countUserMessages(effectiveMessages), [effectiveMessages])
  const sentRef = useRef<{ identity: string | null; count: number }>({ identity: null, count: 0 })
  useEffect(() => {
    const prev = sentRef.current
    sentRef.current = { identity: identity ?? null, count: userCount }
    if (prev.identity !== (identity ?? null) || userCount <= prev.count) return
    if (!stickRef.current) jumpToBottom()
  }, [identity, userCount, jumpToBottom])

  return (
    <div className="v3-session" data-view-key={view.key} data-view-active={viewActive ? '1' : '0'} data-empty={empty && !readOnly ? '' : undefined}>
      <HomeBackdrop active={!readOnly && turns.length === 0 && !switchLoading} asciiEnabled={asciiBackgroundEnabled(settings)} lift={!pane} />
      <ToolExpansionScope.Provider value={expansionScope}>
      <TurnScopeContext.Provider value={source.turnScope}>
      <AsideFitScope.Provider value={asideFits}>
      <div className="v3-stream-host" ref={hostRef} data-arrive={arriveFlip > 0 ? (arriveFlip % 2 ? 'a' : 'b') : undefined} data-jump={showJump && !stick ? '' : undefined}>
        <div className="v3-aside-fit-probe" ref={asideProbeRef} aria-hidden />
        {virtual ? (
          <VList
            key={`${identity}|${remountKey}`}
            ref={vlistRef}
            data={renderTurns}
            className="v3-stream"
            bufferSize={wideBuffer && !narrowBuffer ? VIRTUAL_BUFFER_PX : VIRTUAL_BUFFER_NARROW_PX}
            itemSize={VIRTUAL_ITEM_SIZE_PX}
            keepMounted={keepMounted}
            cache={measurementCache}
            onScroll={onVirtualScroll}
          >
            {(item, index) => flightRef.current?.skim && !flightRef.current.real.has(index) ? (
              <div key={`${identity}|${turnKey(item.id)}`} className="v3-stream-skim" data-row={index} style={{ height: vlistRef.current?.getItemSize(index) ?? VIRTUAL_ITEM_SIZE_PX }} aria-hidden />
            ) : (
              <div key={`${identity}|${turnKey(item.id)}`} data-row={index} className={`v3-stream-row${index === 0 ? ' v3-stream-row--head' : ''}${index === renderTurns.length - 1 ? ' v3-stream-row--tail' : ''}`}>
                {isPending(item) ? <PendingRunNotice /> : <TurnView turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} subagentScope={source.subagentScope} readOnly={readOnly} streaming={item.kind === 'assistant' && item.streaming} tail={item === renderTurns.at(-1)} answer={answers.get(item.id)} outcome={outcomes.get(item.id)} />}
              </div>
            )}
          </VList>
        ) : (
          <div className="v3-stream" ref={setStreamNode} onScroll={onScroll}>
            <div className="v3-stream-inner">
              {turns.length === 0 ? (readOnly ? <PeerEmpty running={!!(session?.isAgentRunning || session?.isStreaming)} /> : switchLoading ? <SwitchSkeleton label={t('chat.switchLoading')} /> : <V3EmptyState key={view.sessionId || identity} />) : renderTurns.map((item) =>
                isPending(item)
                  ? <PendingRunNotice key={`${identity}|${turnKey(item.id)}`} />
                  : <TurnView key={`${identity}|${turnKey(item.id)}`} turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} subagentScope={source.subagentScope} readOnly={readOnly} streaming={item.kind === 'assistant' && item.streaming} tail={item === renderTurns.at(-1)} answer={answers.get(item.id)} outcome={outcomes.get(item.id)} />
              )}
            </div>
          </div>
        )}

        {showJump && !stick && !readOnly ? (
          <div className="v3-jump">
            <Button className="v3-jump-btn" data-testid="v3-jump" variant="glass" size="sm" icon={<ChevronDown size={14} />} aria-label={t('chat.jumpToBottom')} title={t('chat.jumpToBottom')} onPress={jumpToBottom}>
              {t('chat.jumpToBottom')}
            </Button>
          </div>
        ) : null}

        {readOnly ? null : <OutlineRail messages={outlineMessages} streamingId={streamingId} onJump={jumpToTurn} readActiveIndex={readActiveIndex} readRange={readRange} />}
      </div>
      </AsideFitScope.Provider>
      </TurnScopeContext.Provider>
      </ToolExpansionScope.Provider>

      {readOnly ? null : <RewindDialogV3 ownerKey={view.key} active={viewActive} />}

      {readOnly ? null : <MessageMenuHost />}

      {readOnly ? null : <SessionFindBar enabled={viewActive} sessionKey={view.key} getScope={findScope} virtualSource={virtual ? findSource : undefined} />}

    </div>
  )
}
