import { uiText } from '../../i18n/ui-text'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { VList, type VListHandle } from 'virtua'
import { useT } from '../../i18n'
import { streamingMessageId, useStore } from '../../state/store'
import { useThrottledValue } from '../../state/streaming-throttle'
import { createTurnProjector, type Turn } from '../../../../shared/turns'
import { mergeQuestionLog } from '../../../../shared/question-log'
import { TurnView } from './TurnView'
import { sessionWrapUp, withoutWrapUpMessages } from './wrap-up'
import { AsideFitScope, ToolExpansionScope } from './use-tool-run'
import { PendingRunNotice } from './RunNotice'
import { BrowserHandoffCard } from './BrowserHandoffCard'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { OutlineRail, userTurnRenderIndex } from './OutlineRail'
import { Icon } from './Icon'
import { AsciiField } from '../ambient/AsciiField'
import { asciiBackgroundEnabled } from '../ambient/ascii-field-model'
import { approvalMatchesView, sessionViewIdentity, viewMatchesProjectedSession } from './view-state'
import { V3EmptyState } from './V3EmptyState'
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
import { decisionOutcomes, turnAnswers, userTurnOrdinals } from './turn-outcome'
import { messageEntrySignature } from './turn-lines'
import type { BranchPagerBinding } from './BranchPager'
import type { NativeTreeNode } from '../../../../shared/native-session'
import { MessageMenuHost } from './MessageMenu'
import { SessionFindBar } from './SessionFindBar'
import { decideFollow, distanceFromBottom, isScrollIntentKey, JUMP_THRESHOLD_PX, userScrollActive, type FollowDecision, type ReadingAnchor, type ScrollMetrics } from './scroll-follow'
import { domAnchor, domMetrics, glideSettle, keepSettleAnchor, readScrollSnapshot, restoreDomScroll, saveScrollSnapshot, settleAnchor, settleShift, type SettleAnchor } from './scroll-position'
import './session.css'
import { sameComposerView } from '../../state/composer-recovery'
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

const VIRTUALIZE_TURNS_AT = 80
const VIRTUALIZE_MSGS_AT = 200
const LOCATE_MOUNT_FRAMES = 30

type PendingTurn = { kind: 'pending'; id: string }
type RenderItem = Turn | PendingTurn

const isPending = (item: RenderItem): item is PendingTurn => item.kind === 'pending'

function rowAnchor(box: HTMLElement): ReadingAnchor | null {
  const base = box.getBoundingClientRect().top
  for (const node of box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')) {
    const top = node.getBoundingClientRect().top - base
    if (top >= -1) return node.dataset.turnId ? { turnId: node.dataset.turnId, offset: top } : null
  }
  return null
}

function virtualAnchor(handle: VListHandle, items: ReadonlyArray<RenderItem>, box: HTMLElement | null): ReadingAnchor | null {
  const anchor = box ? domAnchor(box) : null
  if (anchor) return anchor
  const index = handle.findItemIndex(handle.scrollOffset)
  const item = items[index]
  if (!item) return null
  return { turnId: item.id, offset: Math.max(0, handle.scrollOffset - handle.getItemOffset(index)) }
}

export function SessionView(): JSX.Element {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const questionLog = useStore((s) => s.questionLog)
  const questionLogSession = useStore((s) => s.questionLogSession)
  const approvalLog = useStore((s) => s.approvalLog)
  const approvalLogSession = useStore((s) => s.approvalLogSession)
  const runTail = useStore((s) => s.runTail)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const approvals = useStore((s) => s.approvals)
  const subagents = useStore((s) => s.subagents)
  const uiRequests = useStore((s) => s.uiRequests)
  const settings = useStore((s) => s.settings)
  const switchLoading = useStore((s) => s.switchLoading)
  const submittingMessages = useStore((s) => s.submittingMessages)

  const view = useMemo(
    () => sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [peekedSessionId, peekedPath, session]
  )
  const viewActive = viewMatchesProjectedSession(view, session)
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
    const run = branchRunRef.current
    const result = await navigatePagerBranch(request, pagerSessionId, targetId, uiText('state.error.branchSwitchFailed'))
    if (!branchAliveRef.current || run !== branchRunRef.current) return
    setBranchPending(null)
    if (!result.ok) {
      setBranchError(result.error || uiText('state.error.branchSwitchFailed'))
      return
    }
    await useStore.getState().refreshSessions()
    if (!branchAliveRef.current || run !== branchRunRef.current) return
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
  const streamingId = viewActive ? streamingMessageId({ session, messages, runTail }) : undefined
  const effectiveMessages = useMemo(
    () => mergeApprovalLogCached(
      mergeQuestionLog(withSubmittingMessages(messages, submittingMessages.filter((item) => sameComposerView(useStore.getState(), item.identity))), questionLogSession && questionLogSession === view.sessionId ? questionLog : []),
      approvalLogSession && approvalLogSession === view.sessionId ? approvalLog : []
    ),
    [messages, submittingMessages, questionLog, questionLogSession, approvalLog, approvalLogSession, view.key, session]
  )
  const visibleMessages = useMemo(() => withoutImageNotices(effectiveMessages), [effectiveMessages])
  const projectedMessages = useMemo(() => withoutWrapUpMessages(visibleMessages), [visibleMessages])
  const turns = useMemo(() => projectTurns(projectedMessages, streamingId), [projectedMessages, streamingId, projectTurns])
  const answers = useMemo(() => turnAnswers(turns), [turns])
  const outcomes = useMemo(() => decisionOutcomes(turns), [turns])
  const ordinals = useMemo(() => userTurnOrdinals(turns), [turns])
  const wrapUpBusy = !!(session?.isAgentRunning || session?.isStreaming || session?.isCompacting)
  const wrapUpOn = settings?.wrapUpCard !== false
  const wrapUp = useMemo(
    () => sessionWrapUp({ enabled: wrapUpOn, active: viewActive, busy: wrapUpBusy, turns, messages: effectiveMessages }),
    [wrapUpOn, viewActive, wrapUpBusy, turns, effectiveMessages]
  )

  const awaitingReply = viewActive && turns.length > 0 && turns[turns.length - 1].kind !== 'assistant' && !!(session?.isAgentRunning || session?.isStreaming)
  const renderTurns = useMemo<RenderItem[]>(
    () => awaitingReply ? [...turns, { kind: 'pending' as const, id: '__pending__' }] : turns,
    [turns, awaitingReply]
  )
  const virtual = turns.length > VIRTUALIZE_TURNS_AT || messages.length > VIRTUALIZE_MSGS_AT

  const identity = view.key
  const [stick, setStick] = useState(true)
  const [showJump, setShowJump] = useState(false)
  const stickRef = useRef(true)
  const intentRef = useRef<number | null>(null)
  const metricsRef = useRef<ScrollMetrics | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const asideProbeRef = useRef<HTMLDivElement | null>(null)
  const [asideFits, setAsideFits] = useState(false)
  const vlistRef = useRef<VListHandle>(null)
  const settlingRef = useRef(false)
  const renderTurnsRef = useRef(renderTurns)
  renderTurnsRef.current = renderTurns
  const [remountKey, setRemountKey] = useState(0)
  const remountsRef = useRef(0)
  const settleRef = useRef<SettleAnchor | null>(null)
  const streamingSeenRef = useRef({ identity, streamingId })
  if (streamingSeenRef.current.identity !== identity || streamingSeenRef.current.streamingId !== streamingId) {
    const seen = streamingSeenRef.current
    if (seen.identity === identity && seen.streamingId && !streamingId && !virtual && streamRef.current) settleRef.current = settleAnchor(streamRef.current)
    streamingSeenRef.current = { identity, streamingId }
  }

  useLayoutEffect(() => {
    const anchor = settleRef.current
    const box = streamRef.current
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
  }, [streamingId])

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

  const applyFollow = useCallback((decision: FollowDecision) => {
    if (stickRef.current !== decision.stick) setStickNow(decision.stick)
    setShowJump(decision.showJump)
  }, [setStickNow])

  const scrollFrameRef = useRef(0)
  const onScroll = useCallback(() => {
    if (scrollFrameRef.current) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      const el = streamRef.current
      if (!el || settlingRef.current) return
      const metrics = domMetrics(el)
      const decision = decideFollow(stickRef.current, metrics, intentRef.current, performance.now(), metricsRef.current)
      applyFollow(decision)
      if (decision.repin) el.scrollTop = el.scrollHeight
      metricsRef.current = decision.repin ? domMetrics(el) : metrics
      readingRef.current = decision.stick ? null : rowAnchor(el)
      record(el.scrollTop, decision.stick, decision.stick ? null : domAnchor(el))
    })
  }, [record, applyFollow])

  useEffect(() => () => cancelAnimationFrame(scrollFrameRef.current), [])

  const onVirtualScroll = useCallback(() => {
    const h = vlistRef.current
    if (!h || settlingRef.current) return
    const metrics = { offset: h.scrollOffset, size: h.scrollSize, viewport: h.viewportSize }
    const decision = decideFollow(stickRef.current, metrics, intentRef.current, performance.now(), metricsRef.current)
    metricsRef.current = metrics
    applyFollow(decision)
    if (decision.repin) h.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
    record(h.scrollOffset, decision.stick, decision.stick ? null : virtualAnchor(h, renderTurnsRef.current, hostRef.current?.querySelector<HTMLElement>('.v3-stream') ?? null))
  }, [record, applyFollow])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const mark = (): void => {
      intentRef.current = performance.now()
      if (stickRef.current) setStickNow(false)
    }
    const wheel = (event: WheelEvent): void => {
      const handle = vlistRef.current
      const metrics = handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
      if (event.deltaY > 0 && metrics && distanceFromBottom(metrics) <= 1) {
        intentRef.current = performance.now()
        setStickNow(true)
      } else mark()
    }
    const onKey = (event: KeyboardEvent): void => { if (isScrollIntentKey(event.key)) mark() }
    const release = (): void => {
      const handle = vlistRef.current
      const metrics = handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
      if (!metrics || stickRef.current || distanceFromBottom(metrics) > 1) return
      intentRef.current = performance.now()
      setStickNow(true)
    }
    const options: AddEventListenerOptions = { passive: true, capture: true }
    host.addEventListener('wheel', wheel, options)
    host.addEventListener('touchmove', mark, options)
    host.addEventListener('pointerdown', mark, options)
    host.addEventListener('pointerup', release, options)
    host.addEventListener('keydown', onKey, options)
    return () => {
      host.removeEventListener('wheel', wheel, options)
      host.removeEventListener('touchmove', mark, options)
      host.removeEventListener('pointerdown', mark, options)
      host.removeEventListener('pointerup', release, options)
      host.removeEventListener('keydown', onKey, options)
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
        if (userScrollActive(intentRef.current, performance.now())) return
        node.scrollTop = node.scrollHeight
        return
      }
      setShowJump(distanceFromBottom(domMetrics(node)) > JUMP_THRESHOLD_PX)
      if (!narrowed) return
      const anchor = readingRef.current
      if (!anchor) return
      const restore = (): void => {
        if (stickRef.current || settlingRef.current) return
        if (userScrollActive(intentRef.current, performance.now())) return
        const target = [...node.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].find((el) => el.dataset.turnId === anchor.turnId)
        if (!target) return
        const offset = target.getBoundingClientRect().top - node.getBoundingClientRect().top
        const max = Math.max(0, node.scrollHeight - node.clientHeight)
        const next = Math.min(Math.max(0, node.scrollTop + offset - anchor.offset), max)
        const shift = next - node.scrollTop
        if (Math.abs(offset - anchor.offset - shift) > 4) return
        if (Math.abs(shift) < 0.5) return
        node.scrollTop = next
        recordRef.current(next, false, { turnId: anchor.turnId, offset: anchor.offset })
      }
      requestAnimationFrame(() => requestAnimationFrame(restore))
    })
    observer.observe(inner)
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

  useLayoutEffect(() => {
    if (!identity || switchLoading) return undefined
    const snap = readScrollSnapshot(identity)
    const bottom = !snap || snap.bottom
    stickRef.current = bottom
    setStick(bottom)
    setShowJump(false)
    intentRef.current = null
    metricsRef.current = null
    settlingRef.current = true
    let settleRaf = 0
    const raf = requestAnimationFrame(() => {
      const anchor = snap?.anchor ?? null
      if (virtual) {
        const handle = vlistRef.current
        const index = anchor ? renderTurnsRef.current.findIndex((item) => item.id === anchor.turnId) : -1
        if (bottom) handle?.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
        else if (anchor && index >= 0) handle?.scrollToIndex(index, { align: 'start', offset: anchor.offset })
        else if (snap) handle?.scrollTo(snap.top)
        if (!bottom && handle) setShowJump(distanceFromBottom({ offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize }) > JUMP_THRESHOLD_PX)
      } else if (streamRef.current) {
        const box = streamRef.current
        restoreDomScroll(box, snap)
        if (!bottom) setShowJump(distanceFromBottom(domMetrics(box)) > JUMP_THRESHOLD_PX)
      }
      if (virtual && !bottom && snap) {
        settleRaf = requestAnimationFrame(() => {
          const box = hostRef.current?.querySelector<HTMLElement>('.v3-stream')
          if (box) {
            restoreDomScroll(box, snap)
            vlistRef.current?.scrollTo(box.scrollTop)
          }
          settlingRef.current = false
        })
      } else settlingRef.current = false
    })
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(settleRaf)
    }
  }, [identity, virtual, remountKey, switchLoading])

  useEffect(() => { remountsRef.current = 0 }, [identity])

  useEffect(() => {
    if (settlingRef.current) return undefined
    if (!stickRef.current) {
      const measure = (): void => {
        if (stickRef.current) return
        const handle = vlistRef.current
        const metrics = virtual && handle ? { offset: handle.scrollOffset, size: handle.scrollSize, viewport: handle.viewportSize } : streamRef.current ? domMetrics(streamRef.current) : null
        if (metrics) setShowJump(distanceFromBottom(metrics) > JUMP_THRESHOLD_PX)
      }
      measure()
      let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(measure) })
      return () => cancelAnimationFrame(raf)
    }
    if (userScrollActive(intentRef.current, performance.now())) return undefined
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurns.length - 1, { align: 'end' })
      return undefined
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
    return undefined
  }, [renderTurns, stick, virtual])

  useEffect(() => {
    if (!virtual) return undefined
    let frames = 0
    let raf = 0
    const tick = (): void => {
      const root = (virtual ? hostRef.current?.querySelector('.v3-stream') : streamRef.current) as HTMLElement | null
      const blank = !!root && root.clientHeight > 0 && root.scrollHeight <= root.clientHeight + 1 && renderTurnsRef.current.length > 0
      if (blank && remountsRef.current < 3) {
        remountsRef.current += 1
        setRemountKey((k) => k + 1)
        return
      }
      if (++frames < 20) { raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [virtual, identity])

  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const outlineMessages = useThrottledValue(visibleMessages, !!streamingId)

  const jumpToTurn = useCallback((userIndex: number) => {
    setStickNow(false)
    const turns = turnsRef.current
    const target = userTurnRenderIndex(turns, userIndex)
    if (target === undefined) return
    if (virtual) {
      vlistRef.current?.scrollToIndex(target, { align: 'start' })
      return
    }
    const box = streamRef.current
    const turn = turns[target]
    const el = turn ? box?.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`) : null
    if (!box || !el) return
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = Math.max(0, top)
  }, [virtual, setStickNow])

  useEffect(() => registerMessageLocator(async (messageId) => {
    const items = renderTurnsRef.current
    const index = items.findIndex((item) => !isPending(item) && (item.id === messageId || (item.kind === 'assistant' && item.sourceIds.includes(messageId))))
    if (index < 0) return false
    setStickNow(false)
    if (virtual) vlistRef.current?.scrollToIndex(index, { align: 'center' })
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
  }), [virtual, setStickNow])

  const findScope = useCallback((): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>('.v3-stream') ?? null, [])

  const jumpToBottom = useCallback(() => {
    setStickNow(true)
    setShowJump(false)
    intentRef.current = null
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setStickNow, virtual])

  const userCount = useMemo(() => countUserMessages(effectiveMessages), [effectiveMessages])
  const sentRef = useRef<{ identity: string | null; count: number }>({ identity: null, count: 0 })
  useEffect(() => {
    const prev = sentRef.current
    sentRef.current = { identity: identity ?? null, count: userCount }
    if (prev.identity !== (identity ?? null) || userCount <= prev.count) return
    if (!stickRef.current) jumpToBottom()
  }, [identity, userCount, jumpToBottom])

  return (
    <div className="v3-session" data-view-key={view.key} data-view-active={viewActive ? '1' : '0'}>
      <AsciiField active={turns.length === 0 && !switchLoading} enabled={asciiBackgroundEnabled(settings)} />
      <ToolExpansionScope.Provider value={identity}>
      <AsideFitScope.Provider value={asideFits}>
      <div className="v3-stream-host" ref={hostRef} data-jump={showJump && !stick ? '' : undefined}>
        <div className="v3-aside-fit-probe" ref={asideProbeRef} aria-hidden />
        {virtual ? (
          <VList
            key={`${identity}|${remountKey}`}
            ref={vlistRef}
            data={renderTurns}
            className="v3-stream"
            bufferSize={800}
            onScroll={onVirtualScroll}
          >
            {(item, index) => (
              <div key={`${identity}|${item.id}`} className={`v3-stream-row${index === 0 ? ' v3-stream-row--head' : ''}${index === renderTurns.length - 1 ? ' v3-stream-row--tail' : ''}`}>
                {isPending(item) ? <PendingRunNotice /> : <TurnView turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} wrapUp={wrapUp?.turnId === item.id ? wrapUp.card : null} tail={item === renderTurns.at(-1)} answer={answers.get(item.id)} outcome={outcomes.get(item.id)} ordinal={ordinals.get(item.id)} />}
              </div>
            )}
          </VList>
        ) : (
          <div className="v3-stream" ref={setStreamNode} onScroll={onScroll}>
            <div className="v3-stream-inner">
              {turns.length === 0 ? (switchLoading ? null : <V3EmptyState key={view.sessionId || identity} />) : renderTurns.map((item) =>
                isPending(item)
                  ? <PendingRunNotice key={`${identity}|${item.id}`} />
                  : <TurnView key={`${identity}|${item.id}`} turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} wrapUp={wrapUp?.turnId === item.id ? wrapUp.card : null} tail={item === renderTurns.at(-1)} answer={answers.get(item.id)} outcome={outcomes.get(item.id)} ordinal={ordinals.get(item.id)} />
              )}
            </div>
          </div>
        )}

        {showJump && !stick ? (
          <button className="v3-jump" data-testid="v3-jump" onClick={jumpToBottom} aria-label={t('chat.jumpToBottom')} title={t('chat.jumpToBottom')}>
            <Icon name="arrow-down" size={14} />
          </button>
        ) : null}

        <OutlineRail messages={outlineMessages} streamingId={streamingId} onJump={jumpToTurn} />
      </div>
      </AsideFitScope.Provider>
      </ToolExpansionScope.Provider>

      <div className="v3-asks">
        {viewActive || (approvals[0] && approvalMatchesView(approvals[0], subagents, view)) ? <ApprovalCard /> : null}
        {viewActive && uiRequests.length > 0 ? <QuestionCard /> : null}
        {viewActive ? <BrowserHandoffCard sessionId={view.sessionId} /> : null}
      </div>

      <RewindDialogV3 ownerKey={view.key} active={viewActive} />

      <MessageMenuHost />

      <SessionFindBar enabled={viewActive} sessionKey={view.key} getScope={findScope} />

    </div>
  )
}
