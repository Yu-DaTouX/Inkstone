import { create } from 'zustand'
import { translate, type Lang } from '../i18n'
import {
  compareRuns,
  isAttentionPhase,
  type RunActivity,
  type RunKind,
  type RunPhase,
  type RunSnapshot
} from '../../../shared/runs'

export type RunLang = 'zh-CN' | 'en-US'

function currentRunLang(): Lang {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN'
}

export interface RunPush {
  revision: number
  upsert: RunSnapshot[]
  remove: string[]
}

export interface RunSnapshotPayload {
  revision: number
  runs: RunSnapshot[]
}

export interface RunsBridge {
  snapshot(): Promise<RunSnapshotPayload>
  markSeen(runId: string): Promise<{ ok: boolean }>
}

export interface RunsV3State {
  revision: number
  runs: RunSnapshot[]
  syncing: boolean
  error: string | null
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

interface RunsV3Store extends RunsV3State {
  dispatch(action: RunsV3Action): void
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

let syncHolders = 0
let syncCleanup: (() => void) | null = null

function beginRunSync(): () => void {
  const bridge = runsBridge()
  const yan = (window as unknown as { yan?: { onPush?: (cb: (msg: unknown) => void) => () => void } }).yan
  let cancelled = false
  let retryTimer: number | null = null

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
      useRunsV3.getState().dispatch({ type: 'snapshot-error', message: translate(currentRunLang(), 'runs.syncUnavailable') })
      return
    }
    if (attempt > 0) useRunsV3.getState().dispatch({ type: 'snapshot-start' })
    try {
      const snapshot = await bridge.snapshot()
      if (cancelled) return
      if (!snapshot || typeof snapshot.revision !== 'number' || !Array.isArray(snapshot.runs)) {
        throw new Error(translate(currentRunLang(), 'runs.snapshotMalformed'))
      }
      useRunsV3.getState().dispatch({ type: 'snapshot', revision: snapshot.revision, runs: snapshot.runs })
    } catch (error) {
      if (cancelled) return
      const message = error instanceof Error ? error.message : String(error)
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

export type RunTone = 'run' | 'ask' | 'stall' | 'fail' | 'done' | 'idle'

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

export function attentionRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  return sortRuns(runs.filter((run) => isAttentionPhase(run.phase)))
}

export interface VisibleSession {
  sessionId?: string
  sessionPath?: string
  peekedPath?: string
}

export function isVisibleRun(run: RunSnapshot, visible: VisibleSession): boolean {
  if (visible.sessionId && run.sessionId === visible.sessionId) return true
  if (visible.sessionPath && run.sessionPath === visible.sessionPath) return true
  if (visible.peekedPath && run.sessionPath === visible.peekedPath) return true
  return false
}

function latestSessionStarts(runs: readonly RunSnapshot[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const run of runs) {
    if (run.kind !== 'session') continue
    const seen = latest.get(run.sessionId)
    if (seen === undefined || run.startedAt > seen) latest.set(run.sessionId, run.startedAt)
  }
  return latest
}

export function isSupersededRun(run: RunSnapshot, latest: ReadonlyMap<string, number>): boolean {
  if (run.kind !== 'session') return false
  const newest = latest.get(run.sessionId)
  return newest !== undefined && newest > run.startedAt
}

export function attentionPills(
  runs: readonly RunSnapshot[],
  visible: VisibleSession,
  max = 2
): RunSnapshot[] {
  const bySession = new Map<string, RunSnapshot>()
  const latest = latestSessionStarts(runs)
  for (const run of attentionRuns(runs)) {
    if (isVisibleRun(run, visible)) continue
    if (isSupersededRun(run, latest)) continue
    const key = run.sessionId || run.runId
    if (!bySession.has(key)) bySession.set(key, run)
  }
  return [...bySession.values()].slice(0, Math.max(0, max))
}

export function isStickyRun(run: RunSnapshot): boolean {
  return run.phase.kind === 'needs-you'
}

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
  review: { zh: '审查', en: 'Review' }
}

function pick(lang: RunLang, entry: { zh: string; en: string }): string {
  return lang === 'en-US' ? entry.en : entry.zh
}

export function phaseWord(lang: RunLang, phase: RunPhase | null): string {
  if (!phase) return ''
  if (phase.kind === 'stalled') return pick(lang, STALL_WORD[phase.cause] ?? PHASE_WORD.stalled)
  return pick(lang, PHASE_WORD[phase.kind])
}

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

export function isUnreadRun(run: RunSnapshot): boolean {
  const phase = run.phase
  return (phase.kind === 'done' || phase.kind === 'failed') && !phase.seen
}

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

export function runTimeText(lang: RunLang, run: RunSnapshot, now: number): string {
  const phase = run.phase
  if (phase.kind === 'failed' || phase.kind === 'stopped' || phase.kind === 'done') {
    return formatRelative(phase.at, now, lang)
  }
  return formatDuration(now - phase.since, lang)
}

export function contextPercent(run: RunSnapshot): number | null {
  return run.context?.percent ?? null
}

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
