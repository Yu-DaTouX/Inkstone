/**
 * 会话视图：自订阅 store，把「正式消息」投影成回合并渲染对话流。
 *
 * 职责边界（CONTRACT）：
 *   · 只读 store（`messages` / `session` / `questionLog` / `runTail`），不直接改 useStore；
 *   · 对话流用 `createTurnProjector` + `mergeQuestionLog`（与 v2 同一套正式逻辑）；
 *   · 长会话用 virtua 虚拟化（阈值见下）；滚动状态**按会话隔离**，流式更新不打断
 *     用户向上阅读；
 *   · 确认卡与提问卡挂在这里（不含 Composer，输入框由外壳单独摆）。
 *
 * 归属：只使用 store 与 preload 暴露的正式窗口 API，不新造确认语义。
 */
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

/** 低频读取原生会话树的去抖窗口：会话 / 稳定 entryId 签名 / 忙态变化后才触发。 */
const PAGER_TREE_DEBOUNCE_MS = 400

/** 宿主原生会话桥的最小接口面（与 `BranchPane` 同形）。 */
interface NativeSessionBridge {
  nativeSession?: BranchPagerRequest
}

function nativeSessionBridge(): BranchPagerRequest | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { yan?: NativeSessionBridge }).yan?.nativeSession
}

/**
 * 虚拟化阈值：**大于** 80 回合或 **大于** 200 消息。
 *
 * 回合数比消息数稳（一个含大量工具的回合会被折成一块）；消息数兜底那些
 * 「回合少但消息极碎」的历史。两者任一超过就上 virtua。
 */
const VIRTUALIZE_TURNS_AT = 80
const VIRTUALIZE_MSGS_AT = 200

type PendingTurn = { kind: 'pending'; id: string }
type RenderItem = Turn | PendingTurn

const isPending = (item: RenderItem): item is PendingTurn => item.kind === 'pending'

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
  const abort = useStore((s) => s.abort)
  const settings = useStore((s) => s.settings)
  const runs = useRunsV3((s) => s.runs)

  /*
   * 当前视图身份：peek 优先、逐字段回退。`session` 只是运行实例的投影，
   * 切到历史会话时它可能还停在上一条；滚动、流式、问答日志与提问卡片都必须
   * 按「眼前这条」而不是「实例那条」判断（见 view-state.ts）。
   */
  const view = useMemo(
    () => sessionViewIdentity({ peekedSessionId, peekedPath, session }),
    [peekedSessionId, peekedPath, session]
  )
  /* 只有视图就是实例正在投影的那条会话时，它的流式 / 等待才属于当前视图。 */
  const viewActive = viewMatchesProjectedSession(view, session)
  /*
   * 回退代码的归属键：与主进程检查点的会话键同一口径（conversationId 优先）；
   * 视图不是活动会话时置空，于是用户回合不画「回退代码」，也不拿别的会话的记录凑数。
   */
  const rewindOwner = viewActive ? (session?.conversationId ?? session?.sessionId ?? null) : null

  /*
   * 检查点刷新：会话键 / 消息条数变化后 400ms 去抖再拉，避免连续推送里反复 IPC。
   * 只在视图确实是活动会话时刷新——peek 别的会话时不冒充前台，也不让别人拿旧列表
   * 在本视图画回退入口。
   */
  const refreshCheckpoints = useStore((s) => s.refreshCheckpoints)
  const checkpointMessages = messages.length
  useEffect(() => {
    if (!viewActive) return undefined
    const timer = window.setTimeout(() => void refreshCheckpoints(), 400)
    return () => window.clearTimeout(timer)
  }, [viewActive, refreshCheckpoints, rewindOwner, checkpointMessages])

  /*
   * 用户消息旁分支切换（设计 §8.8）：只对**当前活动视图**低频读取正式会话树。
   *   · 触发：会话身份 / 消息稳定 entryId 签名变化、会话从忙转闲；400ms 去抖，
   *     再次触发或卸载即取消，不每个 token 请求；
   *   · 只调原生会话桥的 `tree` / `navigate`，不读会话文件、不发消息、不激活其它 pane；
   *   · 切 owner / 卸载用运行序号与 alive 标记作废在途响应；
   *   · 点击时再核 expectedSessionId 与目标 entryId 仍有效，pending 期间禁连点。
   */
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
      /* 卸载即作废在途树读取 / 导航响应。 */
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
    /* 忙时不读；下一轮结束（busy → false）再由本 effect 触发。 */
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
    /* 点击时再核：仍是同一条会话，否则丢弃这次点击。 */
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

  /* 每个视图一份投影缓存：完成的历史回合引用稳定，流式期间只重算变化的那一组 */
  const projectTurns = useMemo(() => createTurnProjector(), [])
  const streamingId = viewActive ? streamingMessageId({ session, messages, runTail }) : undefined
  /* 问答回放合并一次，对话流与大纲轨共用，保证两边的回合下标一致。 */
  const effectiveMessages = useMemo(
    () => mergeQuestionLog(messages, questionLogSession && questionLogSession === view.sessionId ? questionLog : []),
    [messages, questionLog, questionLogSession, view.sessionId]
  )
  const turns = useMemo(() => projectTurns(effectiveMessages, streamingId), [effectiveMessages, streamingId, projectTurns])

  /* 已发送、模型尚无输出：补一行等待状态（只用于渲染，不参与回合索引） */
  const awaitingReply = viewActive && turns.length > 0 && turns[turns.length - 1].kind !== 'assistant' && !!(session?.isAgentRunning || session?.isStreaming)
  const renderTurns = useMemo<RenderItem[]>(
    () => awaitingReply ? [...turns, { kind: 'pending' as const, id: '__pending__' }] : turns,
    [turns, awaitingReply]
  )
  const virtual = turns.length > VIRTUALIZE_TURNS_AT || messages.length > VIRTUALIZE_MSGS_AT

  /*
   * 会话身份：滚动状态按它隔离。`view.key` 取当前视图的文件 / id ——
   * peek 别的会话时不会沿用运行实例的旧身份。
   */
  const identity = view.key
  const [stick, setStick] = useState(true)
  const stickRef = useRef(true)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const vlistRef = useRef<VListHandle>(null)
  /** 每条会话各自的滚动记录：顶部像素 + 是否贴底 */
  const scrollsRef = useRef(new Map<string, { top: number; bottom: boolean }>())
  /** 恢复/换会话的头几帧：真实滚动事件不代表用户阅读意图，别写进记录 */
  const settlingRef = useRef(false)
  /** 恢复时需要最新的回合数与列表句柄，但不因此重建 effect */
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

  /* 非虚拟列表：内容自己长高（图片后加载、成果卡）时，贴底的仍贴底 */
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

  /* 换会话：先取这条会话的记录，没记录过就贴底；随后按记录恢复 */
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

  /* 换会话时重置「空列表重挂」计数 */
  useEffect(() => { remountsRef.current = 0 }, [identity])

  /* 贴底：只在用户确实停在底部时跟随新内容（流式更新不打断向上阅读） */
  useEffect(() => {
    if (!stickRef.current || settlingRef.current) return
    if (virtual) {
      vlistRef.current?.scrollToIndex(renderTurns.length - 1, { align: 'end' })
      return
    }
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [renderTurns, stick, virtual])

  /*
   * 虚拟列表刚挂载时可能量到 0 高度、一行都不画（外壳布局还在稳定）。
   * 挂载后的前几帧检查，空白就换 key 重挂一次（最多 3 次）。
   */
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

  /**
   * 跳到第 N 个用户回合。
   *
   * 定位是「我要看前面」，所以先**同步**关掉跟随底部：否则在滚动到稳定前的
   * 一个流式推送就会把阅读位置重新拉回底部。虚拟化与普通列表分别处理 ——
   * 虚拟化时目标可能还没渲染，不能用 DOM 查询。
   */
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

  /* 子 Agent 侧边详情：只认属于本视图的那次打开 */
  const sidePanel = useSubagentPanel((s) => s.owner === view.key && !!s.runId)

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
      {/* 空态涟漪跨空会话复用画布；首条消息出现时停帧淡出，避免重复初始化图集。 */}
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

        {/* 左侧大纲轨：点刻度跳到对应轮，同时关闭跟随底部。 */}
        <OutlineRail messages={effectiveMessages} streamingId={streamingId} onJump={jumpToTurn} />
      </div>

      {/* 停滞说明卡：只认当前激活视图的运行；停止走正式 store 动作，不自动续跑 */}
      <StalledCard run={currentStalledRun(runs, view, viewActive)} onStop={() => void abort()} />

      {/*
       * 批准 / 提问只挂在「属于当前视图」时：视图是活动会话就照旧显示（含带来源标注的
       * 后台批准），否则只有请求来源明确指向当前视图的批准才显示。隐藏不取消后台请求，
       * 统一 Runs / 侧栏仍能回到来源会话答复，也就不会把 A 的热键挂到 B 底部。
       */}
      <div className="v3-asks">
        {viewActive || (approvals[0] && approvalMatchesView(approvals[0], subagents, view)) ? <ApprovalCard /> : null}
        {viewActive && uiRequests.length > 0 ? <QuestionCard /> : null}
      </div>

      {/* 回退代码对话框：常驻挂载，由它自己按归属键 / 激活状态关闭，避免切会话后旧记录重开 */}
      <RewindDialogV3 ownerKey={view.key} active={viewActive} />

      {/* 子 Agent 详情：宽时与正文并列，窄时覆盖在右侧 */}
      <SubagentPanel ownerKey={view.key} viewActive={viewActive} />
    </div>
  )
}

/**
 * 等待模型的第一段输出：否则这段时间对话流里什么都没有。
 * 与助手消息共用 `.v3-msg.assistant` 列框架，首段输出替换它时左缘不跳。
 */
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
