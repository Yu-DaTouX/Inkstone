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
import { ToolExpansionScope } from './use-tool-run'
import { PendingRunNotice } from './RunNotice'
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
  treeHasEntryId,
  type BranchPagerModel,
  type BranchPagerRequest
} from './branch-pager-model'
import { messageEntrySignature } from './turn-lines'
import type { BranchPagerBinding } from './BranchPager'
import type { NativeTreeNode } from '../../../../shared/native-session'
import { MessageMenuHost } from './MessageMenu'
import { SessionFindBar } from './SessionFindBar'
import { decideFollow, distanceFromBottom, isScrollIntentKey, JUMP_THRESHOLD_PX, pickReadingAnchor, userScrollActive, type FollowDecision, type ReadingAnchor, type ScrollMetrics } from './scroll-follow'
import './session.css'

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
const SCROLL_SNAPSHOT_LIMIT = 32

type PendingTurn = { kind: 'pending'; id: string }
type RenderItem = Turn | PendingTurn

const isPending = (item: RenderItem): item is PendingTurn => item.kind === 'pending'

type ScrollSnapshot = { top: number; bottom: boolean; anchor: ReadingAnchor | null }

function domMetrics(el: HTMLElement): ScrollMetrics {
  return { offset: el.scrollTop, size: el.scrollHeight, viewport: el.clientHeight }
}

function domAnchor(box: HTMLElement): ReadingAnchor | null {
  const base = box.getBoundingClientRect().top
  const rows = [...box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].map((node) => {
    const rect = node.getBoundingClientRect()
    return { id: node.dataset.turnId ?? '', top: rect.top - base, bottom: rect.bottom - base }
  })
  return pickReadingAnchor(rows.filter((row) => row.id), 0)
}

function rowAnchor(box: HTMLElement): ReadingAnchor | null {
  const base = box.getBoundingClientRect().top
  for (const node of box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')) {
    const top = node.getBoundingClientRect().top - base
    if (top >= -1) return node.dataset.turnId ? { turnId: node.dataset.turnId, offset: top } : null
  }
  return null
}

function virtualAnchor(handle: VListHandle, items: ReadonlyArray<RenderItem>): ReadingAnchor | null {
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
  const runTail = useStore((s) => s.runTail)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const approvals = useStore((s) => s.approvals)
  const subagents = useStore((s) => s.subagents)
  const uiRequests = useStore((s) => s.uiRequests)
  const settings = useStore((s) => s.settings)
  const switchLoading = useStore((s) => s.switchLoading)

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
  const entrySignature = useMemo(() => messageEntrySignature(messages), [messages])
  const [branchTree, setBranchTree] = useState<NativeTreeNode[] | null>(null)
  const [branchLeafId, setBranchLeafId] = useState<string | null>(null)
  const [branchPending, setBranchPending] = useState<string | null>(null)
  const [branchError, setBranchError] = useState('')
  const [branchReload, setBranchReload] = useState(0)
  const branchRunRef = useRef(0)
  const branchAliveRef = useRef(true)
  const branchTreeRef = useRef<NativeTreeNode[] | null>(null)
  branchTreeRef.current = branchTree

  useEffect(() => {
    branchAliveRef.current = true
    return () => {
      branchAliveRef.current = false
      branchRunRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!pagerSessionId) {
      setBranchTree(null)
      setBranchLeafId(null)
      setBranchPending(null)
      setBranchError('')
      return undefined
    }
    if (pagerBusy) return undefined
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
    () => mergeQuestionLog(messages, questionLogSession && questionLogSession === view.sessionId ? questionLog : []),
    [messages, questionLog, questionLogSession, view.sessionId]
  )
  const projectedMessages = useMemo(() => withoutWrapUpMessages(effectiveMessages), [effectiveMessages])
  const turns = useMemo(() => projectTurns(projectedMessages, streamingId), [projectedMessages, streamingId, projectTurns])
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
  const vlistRef = useRef<VListHandle>(null)
  const scrollsRef = useRef(new Map<string, ScrollSnapshot>())
  const settlingRef = useRef(false)
  const renderTurnsRef = useRef(renderTurns)
  renderTurnsRef.current = renderTurns
  const [remountKey, setRemountKey] = useState(0)
  const remountsRef = useRef(0)

  const setStickNow = useCallback((value: boolean) => {
    stickRef.current = value
    setStick(value)
  }, [])

  const record = useCallback((top: number, bottom: boolean, anchor: ReadingAnchor | null) => {
    if (!identity) return
    const map = scrollsRef.current
    map.delete(identity)
    map.set(identity, { top, bottom, anchor: bottom ? null : anchor })
    while (map.size > SCROLL_SNAPSHOT_LIMIT) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
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
    record(h.scrollOffset, decision.stick, decision.stick ? null : virtualAnchor(h, renderTurnsRef.current))
  }, [record, applyFollow])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const mark = (): void => { intentRef.current = performance.now() }
    const onKey = (event: KeyboardEvent): void => { if (isScrollIntentKey(event.key)) mark() }
    const options: AddEventListenerOptions = { passive: true, capture: true }
    host.addEventListener('wheel', mark, options)
    host.addEventListener('touchmove', mark, options)
    host.addEventListener('pointerdown', mark, options)
    host.addEventListener('keydown', onKey, options)
    return () => {
      host.removeEventListener('wheel', mark, options)
      host.removeEventListener('touchmove', mark, options)
      host.removeEventListener('pointerdown', mark, options)
      host.removeEventListener('keydown', onKey, options)
    }
  }, [])

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
        node.scrollTop = node.scrollHeight
        return
      }
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
    if (!identity) return undefined
    const snap = scrollsRef.current.get(identity)
    const bottom = !snap || snap.bottom
    stickRef.current = bottom
    setStick(bottom)
    setShowJump(false)
    intentRef.current = null
    metricsRef.current = null
    settlingRef.current = true
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
        const node = anchor ? [...box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].find((el) => el.dataset.turnId === anchor.turnId) : undefined
        if (bottom) box.scrollTop = box.scrollHeight
        else if (anchor && node) box.scrollTop = Math.max(0, node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + anchor.offset)
        else if (snap) box.scrollTop = snap.top
        if (!bottom) setShowJump(distanceFromBottom(domMetrics(box)) > JUMP_THRESHOLD_PX)
      }
      settlingRef.current = false
    })
    return () => cancelAnimationFrame(raf)
  }, [identity, virtual, remountKey])

  useEffect(() => { remountsRef.current = 0 }, [identity])

  useEffect(() => {
    if (!stickRef.current || settlingRef.current) return
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
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
  const outlineMessages = useThrottledValue(effectiveMessages, !!streamingId)

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

  return (
    <div className="v3-session" data-view-key={view.key} data-view-active={viewActive ? '1' : '0'}>
      <AsciiField active={turns.length === 0 && !switchLoading} enabled={asciiBackgroundEnabled(settings)} />
      <ToolExpansionScope.Provider value={identity}>
      <div className="v3-stream-host" ref={hostRef}>
        {virtual ? (
          <VList
            key={`${identity}|${remountKey}`}
            ref={vlistRef}
            data={renderTurns}
            className="v3-stream"
            bufferSize={800}
            onScroll={onVirtualScroll}
          >
            {(item) => (
              <div key={`${identity}|${item.id}`} className="v3-stream-row">
                {isPending(item) ? <PendingRunNotice /> : <TurnView turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} wrapUp={wrapUp?.turnId === item.id ? wrapUp.card : null} />}
              </div>
            )}
          </VList>
        ) : (
          <div className="v3-stream" ref={setStreamNode} onScroll={onScroll}>
            <div className="v3-stream-inner">
              {turns.length === 0 ? (switchLoading ? null : <V3EmptyState key={view.sessionId || identity} />) : renderTurns.map((item) =>
                isPending(item)
                  ? <PendingRunNotice key={`${identity}|${item.id}`} />
                  : <TurnView key={`${identity}|${item.id}`} turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} wrapUp={wrapUp?.turnId === item.id ? wrapUp.card : null} />
              )}
            </div>
          </div>
        )}

        {showJump && !stick ? (
          <button className="v3-jump" data-testid="v3-jump" onClick={jumpToBottom} aria-label={t('chat.jumpToBottom')} title={t('chat.jumpToBottom')}>
            <Icon name="arrow-down" size={16} />
          </button>
        ) : null}

        <OutlineRail messages={outlineMessages} streamingId={streamingId} onJump={jumpToTurn} />
      </div>
      </ToolExpansionScope.Provider>

      <div className="v3-asks">
        {viewActive || (approvals[0] && approvalMatchesView(approvals[0], subagents, view)) ? <ApprovalCard /> : null}
        {viewActive && uiRequests.length > 0 ? <QuestionCard /> : null}
      </div>

      <RewindDialogV3 ownerKey={view.key} active={viewActive} />

      <MessageMenuHost />

      <SessionFindBar enabled={viewActive} sessionKey={view.key} getScope={findScope} />

    </div>
  )
}
