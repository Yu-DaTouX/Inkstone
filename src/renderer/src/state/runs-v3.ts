/**
 * v3 运行状态的渲染端镜像（WP-11–14）。
 *
 * 权威仍在主进程 `src/main/runs/**`：它把 `RunSnapshot` 经 `ch:'runs'` 推送过来，
 * 并用 `runs.snapshot()` 提供带修订号的权威全量。这里只做三件事：
 *   1. 纯归约：把增量合并进按 `compareRuns` 排序的列表，丢弃旧修订；
 *   2. zustand 存储：给 RunDot / RunPill / RunPopover / RunsPage 共用一份视图；
 *   3. `startRunSync()`：订阅先于快照，快照在途时缓冲增量，回来只回放更新的修订。
 *
 * ── 为什么要有缓冲 ──
 * `snapshot()` 是异步的。若先拉快照、后订阅，期间的状态变化会永久丢失；
 * 若先订阅但直接应用，慢的快照返回后会把已经「完成」的运行覆盖回「运行中」。
 * 所以：订阅 → 请求快照 → 期间增量进 buffer → 快照落地后只回放
 * `revision > snapshot.revision` 的条目。
 *
 * 纯函数（reducer / 合并 / 排序 / 文案）与 zustand 存储放在同一文件，测试直接
 * 编译本文件跑 reducer，不启动 Electron、不碰 pi、不写用户目录。
 */
import { create } from 'zustand'
import {
  compareRuns,
  isAttentionPhase,
  type RunActivity,
  type RunKind,
  type RunPhase,
  type RunSnapshot
} from '../../../shared/runs'

/** 与 i18n 的 `Lang` 同形；这里只需要两个字面量，不引入 i18n 运行时。 */
export type RunLang = 'zh-CN' | 'en-US'

/** 主进程一次推送的增量。修订号随每次 publish 单调递增。 */
export interface RunPush {
  revision: number
  upsert: RunSnapshot[]
  remove: string[]
}

/** `runs.snapshot()` 的返回：权威修订号 + 当时的完整列表。 */
export interface RunSnapshotPayload {
  revision: number
  runs: RunSnapshot[]
}

/** `window.yan.runs` 的最小接口；主进程接线（G）完成后由 preload 提供。 */
export interface RunsBridge {
  snapshot(): Promise<RunSnapshotPayload>
  markSeen(runId: string): Promise<{ ok: boolean }>
}

/* ────────────────────────── 纯归约 ────────────────────────── */

export interface RunsV3State {
  /** 已应用的最新发布修订号；-1 = 还没拿到任何权威数据 */
  revision: number
  runs: RunSnapshot[]
  /** snapshot 请求在途；期间推送先缓冲，不直接改 runs */
  syncing: boolean
  /** 同步失败时的可见原因；null = 正常。绝不用它把界面伪装成「空闲」 */
  error: string | null
  /** snapshot 在途时暂存的增量，落地后按修订号回放 */
  buffer: RunPush[]
}

export type RunsV3Action =
  | { type: 'push'; push: RunPush }
  | { type: 'snapshot-start' }
  | { type: 'snapshot'; revision: number; runs: RunSnapshot[] }
  | { type: 'snapshot-error'; message: string }
  | { type: 'seen'; runId: string }

export const initialRunsV3State: RunsV3State = {
  revision: -1,
  runs: [],
  syncing: false,
  error: null,
  buffer: []
}

/** 按 runId 合并一次增量；`remove` 优先于旧条目，`upsert` 覆盖同 runId。 */
export function mergeRunUpdates(
  runs: readonly RunSnapshot[],
  update: { upsert: readonly RunSnapshot[]; remove: readonly string[] }
): RunSnapshot[] {
  const byId = new Map<string, RunSnapshot>()
  for (const run of runs) byId.set(run.runId, run)
  for (const id of update.remove) byId.delete(id)
  for (const run of update.upsert) byId.set(run.runId, run)
  return [...byId.values()].sort(compareRuns)
}

/** 只把更新的修订合并进来，旧修订返回原数组（引用不变，便于 React 跳过渲染）。 */
export function reducePush(runs: readonly RunSnapshot[], push: RunPush, revision: number): RunSnapshot[] {
  if (push.revision <= revision) return runs as RunSnapshot[]
  return mergeRunUpdates(runs, push)
}

function applyPush(state: RunsV3State, push: RunPush): RunsV3State {
  if (push.revision <= state.revision) return state
  return {
    ...state,
    revision: push.revision,
    runs: mergeRunUpdates(state.runs, push)
  }
}

/** 翻转完成 / 失败运行的已读标记；其它阶段不动。 */
export function markSeenInRuns(runs: readonly RunSnapshot[], runId: string): RunSnapshot[] {
  let changed = false
  const next = runs.map((run) => {
    if (run.runId !== runId) return run
    const phase = run.phase
    if ((phase.kind === 'done' || phase.kind === 'failed') && !phase.seen) {
      changed = true
      return { ...run, phase: { ...phase, seen: true } }
    }
    return run
  })
  return changed ? next : (runs as RunSnapshot[])
}

/**
 * 同步状态机。纯函数，测试直接覆盖。
 *
 * 关键行为：
 *   · syncing 期间的 push 进 buffer；
 *   · snapshot 落地替换列表，然后只回放 revision 更大的缓冲增量；
 *   · snapshot 失败保留已有列表并暴露 error，不清空成「空闲」。
 */
export function runsV3Reducer(state: RunsV3State, action: RunsV3Action): RunsV3State {
  switch (action.type) {
    case 'push':
      if (state.syncing) return { ...state, buffer: [...state.buffer, action.push] }
      return applyPush(state, action.push)

    case 'snapshot-start':
      return { ...state, syncing: true, error: null, buffer: [] }

    case 'snapshot': {
      const base: RunsV3State = {
        ...state,
        revision: action.revision,
        runs: [...action.runs].sort(compareRuns),
        syncing: false,
        error: null,
        buffer: []
      }
      let next = base
      for (const push of state.buffer) next = applyPush(next, push)
      return next
    }

    case 'snapshot-error':
      return { ...state, syncing: false, error: action.message, buffer: [] }

    case 'seen':
      return { ...state, runs: markSeenInRuns(state.runs, action.runId) }

    default:
      return state
  }
}

/* ────────────────────── zustand 存储 ────────────────────── */

interface RunsV3Store extends RunsV3State {
  dispatch(action: RunsV3Action): void
  /** 标记已读：先本地生效，再通知主进程（失败也不回滚，下一次推送会对齐）。 */
  requestMarkSeen(runId: string): void
}

export const useRunsV3 = create<RunsV3Store>((set) => ({
  ...initialRunsV3State,
  dispatch: (action) => set((state) => runsV3Reducer(state, action)),
  requestMarkSeen: (runId) => {
    set((state) => runsV3Reducer(state, { type: 'seen', runId }))
    const bridge = runsBridge()
    if (bridge) void bridge.markSeen(runId).catch(() => undefined)
  }
}))

/** 拿 `window.yan.runs`；G 尚未接线时返回 null，调用方显示可见错误。 */
export function runsBridge(): RunsBridge | null {
  const yan = (window as unknown as { yan?: { runs?: RunsBridge } }).yan
  const runs = yan?.runs
  if (!runs || typeof runs.snapshot !== 'function' || typeof runs.markSeen !== 'function') return null
  return runs
}

function isRunsPush(msg: unknown): msg is { ch: 'runs'; payload: RunPush } {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { ch?: unknown; payload?: unknown }
  if (candidate.ch !== 'runs') return false
  const payload = candidate.payload as Partial<RunPush> | null
  return !!payload && typeof payload.revision === 'number' && (Array.isArray(payload.upsert) || Array.isArray(payload.remove))
}

/* ────────────── 订阅 / 快照竞态（startRunSync） ────────────── */

let syncHolders = 0
let syncCleanup: (() => void) | null = null

function beginRunSync(): () => void {
  const bridge = runsBridge()
  const yan = (window as unknown as { yan?: { onPush?: (cb: (msg: unknown) => void) => () => void } }).yan
  let cancelled = false
  let retryTimer: number | null = null

  /* 先订阅：快照请求之前的状态变化也进队列，不会丢。 */
  const offPush = yan?.onPush
    ? yan.onPush((msg) => {
        if (!isRunsPush(msg)) return
        useRunsV3.getState().dispatch({ type: 'push', push: msg.payload })
      })
    : () => undefined

  useRunsV3.getState().dispatch({ type: 'snapshot-start' })

  const fetchSnapshot = async (attempt: number): Promise<void> => {
    if (cancelled) return
    if (!bridge) {
      useRunsV3.getState().dispatch({ type: 'snapshot-error', message: '运行状态通道不可用' })
      return
    }
    /* 每次尝试都重新进入 syncing：重试期间到达的增量也要缓冲，
       否则比快照更旧的重试返回会把它们覆盖掉。 */
    if (attempt > 0) useRunsV3.getState().dispatch({ type: 'snapshot-start' })
    try {
      const snapshot = await bridge.snapshot()
      if (cancelled) return
      if (!snapshot || typeof snapshot.revision !== 'number' || !Array.isArray(snapshot.runs)) {
        throw new Error('运行快照格式不完整')
      }
      useRunsV3.getState().dispatch({ type: 'snapshot', revision: snapshot.revision, runs: snapshot.runs })
    } catch (error) {
      if (cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      /* 立即暴露错误；界面据此显示「同步失败」，而不是空列表冒充空闲。 */
      useRunsV3.getState().dispatch({ type: 'snapshot-error', message })
      if (attempt < 2) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          void fetchSnapshot(attempt + 1)
        }, 2000)
      }
    }
  }

  void fetchSnapshot(0)

  return () => {
    cancelled = true
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
    offPush()
  }
}

/**
 * 启动运行状态同步；返回严格清理函数。
 *
 * 多次调用共用同一个订阅（引用计数）：StrictMode 的「挂载 → 清理 → 再挂载」
 * 会先减到 0 拆掉，再重建，不会叠加两条 `onPush` 订阅；返回的清理函数可重复调用。
 */
export function startRunSync(): () => void {
  syncHolders += 1
  if (!syncCleanup) syncCleanup = beginRunSync()
  let released = false
  return () => {
    if (released) return
    released = true
    syncHolders -= 1
    if (syncHolders <= 0) {
      syncHolders = 0
      const cleanup = syncCleanup
      syncCleanup = null
      cleanup?.()
    }
  }
}

/* ──────────────── 排序 / 筛选 / 文案（组件共用） ──────────────── */

export type RunTone = 'run' | 'ask' | 'stall' | 'fail' | 'done' | 'idle'

/** 语义色：needs-you→ask、stalled→stall、failed→fail、运行/排队→run、完成→done。 */
export function runTone(phase: RunPhase | null): RunTone {
  switch (phase?.kind) {
    case 'running':
    case 'queued':
      return 'run'
    case 'needs-you':
      return 'ask'
    case 'stalled':
      return 'stall'
    case 'failed':
      return 'fail'
    case 'done':
      return 'done'
    default:
      return 'idle'
  }
}

export function sortRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  return [...runs].sort(compareRuns)
}

/** 只留需要用户注意的运行（等你确认 / 停滞 / 失败）。 */
export function attentionRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  return sortRuns(runs.filter((run) => isAttentionPhase(run.phase)))
}

export interface VisibleSession {
  sessionId?: string
  sessionPath?: string
  peekedPath?: string
}

/** 某个运行是否就是当前正在看的会话（用于提醒条不重复报同一件事）。 */
export function isVisibleRun(run: RunSnapshot, visible: VisibleSession): boolean {
  if (visible.sessionId && run.sessionId === visible.sessionId) return true
  if (visible.sessionPath && run.sessionPath === visible.sessionPath) return true
  if (visible.peekedPath && run.sessionPath === visible.peekedPath) return true
  return false
}

/**
 * 提醒条要显示的最多 `max` 条：同一会话只留最高优先的一条，
 * 过滤当前可见会话，其余按 `compareRuns`（等你确认最前）。
 */
export function attentionPills(
  runs: readonly RunSnapshot[],
  visible: VisibleSession,
  max = 2
): RunSnapshot[] {
  const bySession = new Map<string, RunSnapshot>()
  for (const run of attentionRuns(runs)) {
    if (isVisibleRun(run, visible)) continue
    const key = run.sessionId || run.runId
    if (!bySession.has(key)) bySession.set(key, run)
  }
  return [...bySession.values()].slice(0, Math.max(0, max))
}

/** 待审批 / 待回答的运行不允许关闭，其余低优先项可关。 */
export function isStickyRun(run: RunSnapshot): boolean {
  return run.phase.kind === 'needs-you'
}

/* ── 文案：组件与测试共用；缺数据一律「—」，不编造 ── */

const PHASE_WORD: Record<RunPhase['kind'], { zh: string; en: string }> = {
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  'needs-you': { zh: '等你确认', en: 'Needs you' },
  stalled: { zh: '停滞', en: 'Stalled' },
  failed: { zh: '失败', en: 'Failed' },
  stopped: { zh: '已停止', en: 'Stopped' },
  done: { zh: '已完成', en: 'Done' }
}

const STALL_WORD: Record<string, { zh: string; en: string }> = {
  'no-output': { zh: '无响应', en: 'No output' },
  'tool-silent': { zh: '工具无输出', en: 'Tool silent' },
  retry: { zh: '重试中', en: 'Retrying' },
  'rate-limit': { zh: '限流等待', en: 'Rate limited' },
  loop: { zh: '重复输出', en: 'Looping' }
}

const FAIL_WORD: Record<string, { zh: string; en: string }> = {
  'model-error': { zh: '模型错误', en: 'Model error' },
  'pi-exit': { zh: 'pi 退出', en: 'pi exited' },
  'tool-fatal': { zh: '工具致命错误', en: 'Tool fatal' },
  host: { zh: '宿主错误', en: 'Host error' }
}

const ACTIVITY_WORD: Record<RunActivity, { zh: string; en: string }> = {
  'waiting-model': { zh: '等待模型', en: 'Waiting for model' },
  thinking: { zh: '思考中', en: 'Thinking' },
  streaming: { zh: '生成回复', en: 'Responding' },
  tool: { zh: '调用工具', en: 'Using tool' },
  compacting: { zh: '压缩中', en: 'Compacting' },
  subagent: { zh: '子 Agent', en: 'Subagent' }
}

const KIND_WORD: Record<RunKind, { zh: string; en: string }> = {
  session: { zh: '会话', en: 'Session' },
  subagent: { zh: '子 Agent', en: 'Subagent' },
  scheduled: { zh: '定时', en: 'Scheduled' },
  review: { zh: '评审', en: 'Review' }
}

function pick(lang: RunLang, entry: { zh: string; en: string }): string {
  return lang === 'en-US' ? entry.en : entry.zh
}

/** 阶段短词；停滞按原因细分，不做「统一叫停滞」的糊法。 */
export function phaseWord(lang: RunLang, phase: RunPhase | null): string {
  if (!phase) return ''
  if (phase.kind === 'stalled') return pick(lang, STALL_WORD[phase.cause] ?? PHASE_WORD.stalled)
  return pick(lang, PHASE_WORD[phase.kind])
}

/** 阶段详情：真实错误 / 工具名 / 请求摘要；没有就 null（组件显示「—」）。 */
export function phaseDetail(lang: RunLang, phase: RunPhase | null): string | null {
  if (!phase) return null
  switch (phase.kind) {
    case 'failed':
      return phase.message || pick(lang, FAIL_WORD[phase.cause] ?? PHASE_WORD.failed)
    case 'stalled':
      if (phase.retry) return `${phase.retry.attempt}/${phase.retry.max}`
      return phase.detail ?? null
    case 'needs-you':
      return phase.request.summary || null
    case 'running':
      return phase.activity === 'tool' && phase.tool ? phase.tool.label : activityWord(lang, phase.activity)
    default:
      return null
  }
}

export function activityWord(lang: RunLang, activity: RunActivity): string {
  return pick(lang, ACTIVITY_WORD[activity])
}

export function kindWord(lang: RunLang, kind: RunKind): string {
  return pick(lang, KIND_WORD[kind])
}

/** 运行是否还没被用户看过（完成 / 失败且 `seen=false`）。 */
export function isUnreadRun(run: RunSnapshot): boolean {
  const phase = run.phase
  return (phase.kind === 'done' || phase.kind === 'failed') && !phase.seen
}

/** 工具计数摘要；始终展示真实计数（0 也如实显示）。 */
export function toolSummary(lang: RunLang, run: RunSnapshot): string {
  const { tools, edits, errors } = run.counts
  if (lang === 'en-US') {
    const parts = [`${tools} tool${tools === 1 ? '' : 's'}`]
    if (edits) parts.push(`${edits} edit${edits === 1 ? '' : 's'}`)
    if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }
  const parts = [`工具 ${tools}`]
  if (edits) parts.push(`改动 ${edits}`)
  if (errors) parts.push(`错误 ${errors}`)
  return parts.join(' · ')
}

export function modelLabel(run: RunSnapshot): string | null {
  if (!run.model) return null
  const name = run.model.label || run.model.id
  return run.model.thinking ? `${name} · ${run.model.thinking}` : name
}

export function formatDuration(ms: number, lang: RunLang): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (lang === 'en-US') {
    if (h) return `${h}h ${m}m`
    if (m) return `${m}m ${s}s`
    return `${s}s`
  }
  if (h) return `${h} 小时 ${m} 分`
  if (m) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

export function formatRelative(at: number, now: number, lang: RunLang): string {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return lang === 'en-US' ? 'just now' : '刚刚'
  if (delta < 3_600_000) {
    const n = Math.floor(delta / 60_000)
    return lang === 'en-US' ? `${n} min ago` : `${n} 分钟前`
  }
  if (delta < 86_400_000) {
    const n = Math.floor(delta / 3_600_000)
    return lang === 'en-US' ? `${n} h ago` : `${n} 小时前`
  }
  return new Date(at).toLocaleDateString(lang)
}

/**
 * 一行的「时间」列：进行中看已持续时间，终态看发生时间。
 * 不依赖任何推测的 runner 阶段，只读快照上的 startedAt / phase。
 */
export function runTimeText(lang: RunLang, run: RunSnapshot, now: number): string {
  const phase = run.phase
  if (phase.kind === 'failed' || phase.kind === 'stopped' || phase.kind === 'done') {
    return formatRelative(phase.at, now, lang)
  }
  return formatDuration(now - phase.since, lang)
}

/** 真实上下文占用百分比；没有就 null（组件显示「—」）。 */
export function contextPercent(run: RunSnapshot): number | null {
  return run.context?.percent ?? null
}

/** 组件共用的界面文案；缺数据的占位符统一为 `—`。 */
export interface RunUiText {
  attention: string
  dismiss: string
  showAll: string
  untitled: string
  runsTitle: string
  runsEmpty: string
  runsLoading: string
  syncError: string
  openSession: string
  fieldCode: string
  fieldTitle: string
  fieldModel: string
  fieldStatus: string
  fieldTools: string
  fieldTime: string
  fieldKind: string
  fieldContext: string
  none: string
}

export function runUiText(lang: RunLang): RunUiText {
  if (lang === 'en-US') {
    return {
      attention: 'Needs attention',
      dismiss: 'Dismiss',
      showAll: 'All runs',
      untitled: 'Untitled',
      runsTitle: 'Runs',
      runsEmpty: 'No runs yet. Start a task and it will show up here.',
      runsLoading: 'Syncing run status…',
      syncError: 'Run status sync failed',
      openSession: 'Open session',
      fieldCode: 'Code',
      fieldTitle: 'Title',
      fieldModel: 'Model',
      fieldStatus: 'Status',
      fieldTools: 'Tools',
      fieldTime: 'Time',
      fieldKind: 'Kind',
      fieldContext: 'Context',
      none: '—'
    }
  }
  return {
    attention: '需要处理',
    dismiss: '关闭提醒',
    showAll: '全部运行',
    untitled: '未命名',
    runsTitle: '运行总览',
    runsEmpty: '暂无运行。开始一件任务，它会出现在这里。',
    runsLoading: '正在同步运行状态…',
    syncError: '运行状态同步失败',
    openSession: '回到会话',
    fieldCode: '编号',
    fieldTitle: '标题',
    fieldModel: '模型',
    fieldStatus: '状态',
    fieldTools: '工具',
    fieldTime: '时间',
    fieldKind: '类型',
    fieldContext: '上下文',
    none: '—'
  }
}
