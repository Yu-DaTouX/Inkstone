import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { VList, type VListHandle } from 'virtua'
import { useT } from '../../i18n'
import { streamingMessageId, useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { createTurnProjector, type Turn } from '../../../../shared/turns'
import { mergeQuestionLog } from '../../../../shared/question-log'
import { TurnView } from './TurnView'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { OutlineRail, userTurnRenderIndex } from './OutlineRail'
import { StalledCard, currentStalledRun } from './StalledCard'
import { Icon } from './Icon'
import { Busy } from './Busy'
import { AsciiField } from '../ambient/AsciiField'
import { asciiBackgroundEnabled } from '../ambient/ascii-field-model'
import { approvalMatchesView, sessionViewIdentity, viewMatchesProjectedSession } from './view-state'
import { V3EmptyState } from './V3EmptyState'
import { RewindDialogV3 } from './RewindDialogV3'
import { SubagentPanel } from './SubagentPanel'
import { useSubagentPanel } from './subagent-panel-state'
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

type PendingTurn = { kind: 'pending'; id: string }
type RenderItem = Turn | PendingTurn

const isPending = (item: RenderItem): item is PendingTurn => item.kind === 'pending'

export function SessionView({ subagentPanel = true }: { subagentPanel?: boolean } = {}): JSX.Element {
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
  const abort = useStore((s) => s.abort)
  const settings = useStore((s) => s.settings)
  const runs = useRunsV3((s) => s.runs)

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
      void loadPagerTree(request, pagerSessionId, '会话树读取失败').then((result) => {
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
      setBranchError('目标分支已失效，请重试')
      return
    }
    const request = nativeSessionBridge()
    if (!request) {
      setBranchError('宿主尚未提供原生会话桥')
      return
    }
    setBranchPending(targetId)
    setBranchError('')
    const run = branchRunRef.current
    const result = await navigatePagerBranch(request, pagerSessionId, targetId, '分支切换失败')
    if (!branchAliveRef.current || run !== branchRunRef.current) return
    setBranchPending(null)
    if (!result.ok) {
      setBranchError(result.error || '分支切换失败')
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
  const turns = useMemo(() => projectTurns(effectiveMessages, streamingId), [effectiveMessages, streamingId, projectTurns])

  const awaitingReply = viewActive && turns.length > 0 && turns[turns.length - 1].kind !== 'assistant' && !!(session?.isAgentRunning || session?.isStreaming)
  const renderTurns = useMemo<RenderItem[]>(
    () => awaitingReply ? [...turns, { kind: 'pending' as const, id: '__pending__' }] : turns,
    [turns, awaitingReply]
  )
  const virtual = turns.length > VIRTUALIZE_TURNS_AT || messages.length > VIRTUALIZE_MSGS_AT

  const identity = view.key
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const vlistRef = useRef<VListHandle>(null)
  const scrollsRef = useRef(new Map<string, { top: number; bottom: boolean }>())
  const settlingRef = useRef(false)
  const renderTurnsRef = useRef(renderTurns)
  renderTurnsRef.current = renderTurns
  const [remountKey, setRemountKey] = useState(0)
  const remountsRef = useRef(0)

  const setStickNow = useCallback((value: boolean) => {
    stickRef.current = value
    setStick(value)
  }, [])

  const record = useCallback((top: number, bottom: boolean) => {
    if (!identity) return
    scrollsRef.current.set(identity, { top, bottom })
  }, [identity])

  const onScroll = useCallback(() => {
    const el = streamRef.current
    if (!el || settlingRef.current) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setStickNow(atBottom)
    record(el.scrollTop, atBottom)
  }, [record, setStickNow])

  const onVirtualScroll = useCallback(() => {
    const h = vlistRef.current
    if (!h || settlingRef.current) return
    const atBottom = h.scrollSize - h.scrollOffset - h.viewportSize < 40
    setStickNow(atBottom)
    record(h.scrollOffset, atBottom)
  }, [record, setStickNow])

  const setStreamNode = useCallback((node: HTMLDivElement | null) => {
    streamRef.current = node
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    const inner = node.firstElementChild
    if (!inner) return
    const observer = new ResizeObserver(() => {
      if (stickRef.current && !settlingRef.current) node.scrollTop = node.scrollHeight
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
    settlingRef.current = true
    const raf = requestAnimationFrame(() => {
      if (virtual) {
        if (bottom) vlistRef.current?.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
        else if (snap) vlistRef.current?.scrollTo(snap.top)
      } else if (streamRef.current) {
        if (bottom) streamRef.current.scrollTop = streamRef.current.scrollHeight
        else if (snap) streamRef.current.scrollTop = snap.top
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

  const jumpToTurn = useCallback((userIndex: number) => {
    setStickNow(false)
    const target = userTurnRenderIndex(turns, userIndex)
    if (target === undefined) return
    if (virtual) {
      vlistRef.current?.scrollToIndex(target, { align: 'start' })
      return
    }
    requestAnimationFrame(() => {
      const box = streamRef.current
      const turn = turns[target]
      const el = turn ? box?.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`) : null
      if (!box || !el) return
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      box.scrollTop = Math.max(0, top)
      setStickNow(false)
    })
  }, [turns, virtual, setStickNow])

  const sidePanel = useSubagentPanel((s) => subagentPanel && s.owner === view.key && !!s.runId)

  const jumpToBottom = useCallback(() => {
    setStickNow(true)
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurnsRef.current.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setStickNow, virtual])

  return (
    <div className="v3-session" data-view-key={view.key} data-view-active={viewActive ? '1' : '0'} data-side-panel={sidePanel ? '1' : undefined}>
      <AsciiField active={turns.length === 0} enabled={asciiBackgroundEnabled(settings)} />
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
                {isPending(item) ? <PendingActivity /> : <TurnView turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} />}
              </div>
            )}
          </VList>
        ) : (
          <div className="v3-stream" ref={setStreamNode} onScroll={onScroll}>
            <div className="v3-stream-inner">
              {turns.length === 0 ? <V3EmptyState key={view.sessionId || identity} /> : renderTurns.map((item) =>
                isPending(item)
                  ? <PendingActivity key={`${identity}|${item.id}`} />
                  : <TurnView key={`${identity}|${item.id}`} turn={item} sessionId={view.sessionId} rewindOwner={rewindOwner} branchPager={branchPager} streaming={item.kind === 'assistant' && item.streaming} />
              )}
            </div>
          </div>
        )}

        {!stick ? (
          <button className="v3-jump" onClick={jumpToBottom} aria-label={t('chat.jumpToBottom')} title={t('chat.jumpToBottom')}>
            <Icon name="arrow-down" size={16} />
          </button>
        ) : null}

        <OutlineRail messages={effectiveMessages} streamingId={streamingId} onJump={jumpToTurn} />
      </div>

      <StalledCard run={currentStalledRun(runs, view, viewActive)} onStop={() => void abort()} />

      <div className="v3-asks">
        {viewActive || (approvals[0] && approvalMatchesView(approvals[0], subagents, view)) ? <ApprovalCard /> : null}
        {viewActive && uiRequests.length > 0 ? <QuestionCard /> : null}
      </div>

      <RewindDialogV3 ownerKey={view.key} active={viewActive} />

      {subagentPanel ? <SubagentPanel ownerKey={view.key} viewActive={viewActive} /> : null}
    </div>
  )
}

function PendingActivity(): JSX.Element {
  const t = useT()
  return (
    <div className="v3-msg assistant" data-testid="v3-pending">
      <div className="v3-act" data-kind="run">
        <Busy />
        <span className="v3-act-text" role="status" aria-live="polite">{t('chat.working')}</span>
      </div>
    </div>
  )
}
