import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { SubagentHistory } from './subagent-history'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import type { SubagentEndReason, SubagentRecovery, SubagentRun, SubagentStopResult, UIMessage } from '../shared/ipc'
import { normalizeMessage, toUsage, type PiMessage } from './normalize'
import { accumulateUsage, ingestUsageSnapshot, normalizeSubagentContextUsage, type SubagentUsageTotals, type UsageSnapshots } from '../shared/subagent-usage'
import {
  briefPrompt,
  parseSubagentBrief,
  summarizeSubagentRun,
  type SubagentBrief
} from '../shared/subagent-brief'
import { PiRpc, resolvePi } from './protocol'
import { CapabilityServer, type CapabilityCommandResult } from './capability-server'
import { nativePiToolsSupported } from '../shared/agent-context'
import { isTransientModelError, modelErrorNotice, modelErrorText } from '../shared/model-errors'
import { redactDiagnosticText } from '../shared/redact-diagnostic'
import { subagentModelError, subagentPiArgs } from '../shared/subagent-pi-launch'
import { confirmRegisteredModel } from './subagents/registered-model'
import { forkPiArgs, forkPrompt, writeForkSession, type SubagentForkSource } from './subagent-fork'
import { runArtifactPreview, type PreviewHtml } from './artifact-preview-command'
import {
  applyPatch,
  cleanupWorkspace as removeWorkspace,
  collectDiff,
  prepareWorkspace,
  type PreparedWorkspace
} from './subagent-isolation'

const MAX_CONCURRENT = 24
const STALL_TIMEOUT_MS = 10 * 60 * 1000
const GRACE_MS = 75 * 1000
const TOOL_RUNNING_STALL_FACTOR = 6
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor'])
const PROGRESS_EVENTS = new Set(['agent_start', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end',
  'agent_end', 'auto_retry_start', 'auto_retry_end'])

function envMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}
function limitsFor(brief: SubagentBrief): { totalMs?: number; idleMs: number; graceMs: number } {
  const total = envMs('YAN_SUBAGENT_TIMEOUT_MS') ?? (brief.timeoutMinutes ? brief.timeoutMinutes * 60_000 : undefined)
  return { totalMs: total, idleMs: envMs('YAN_SUBAGENT_IDLE_MS') ?? STALL_TIMEOUT_MS, graceMs: envMs('YAN_SUBAGENT_GRACE_MS') ?? GRACE_MS }
}

function spanText(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms >= 1_000) return `${Math.round(ms / 1000)} 秒`
  return `${ms} 毫秒`
}
const totalTimeoutText = (ms: number): string => `运行超时（超过 ${spanText(ms)}）`
const stallTimeoutText = (ms: number): string => `停滞超时（超过 ${spanText(ms)} 未收到模型输出或工具事件）`

function wrapUpMessage(text: string): string {
  return `【宿主提示】${text}。不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。`
}
const MAX_TRANSCRIPT = 200
const ABORT_TIMEOUT_MS = 5_000

async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<void> {
  const result = await removeWorkspace(workspace)
  for (const error of result.errors) console.warn(`[subagent] ${error}`)
}
const DRAIN_CONCURRENCY = 4

const MAX_STDERR_LINES = 20
const MAX_STDERR_LINE_CHARS = 400

function redactCredentialShapes(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[redacted]@')
    .replace(
      /([?&])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|token|key|secret|password|passwd|credential|authorization|auth)=[^&\s"']+/gi,
      '$1[redacted]'
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*$|'(?:\\.|[^'\\])*$)/gi,
      '$1[redacted]'
    )
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(
      /(\b(?:x-api-key|api[-_]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)\b\s*[:=]\s*)[^\s,;"'&?]+/gi,
      '$1[redacted]'
    )
}

export function redactLocalDiagnostic(text: string, max = MAX_STDERR_LINE_CHARS): string | undefined {
  return redactDiagnosticText(redactCredentialShapes(text), max) ?? undefined
}

export function sanitizeStderrLine(line: string): string | undefined {
  return redactLocalDiagnostic(line, MAX_STDERR_LINE_CHARS)
}

export function describeProcessExit(
  info: { code?: number | null; signal?: string | null; spawnError?: string },
  stderrTail: readonly string[]
): string {
  const facts: string[] = []
  if (info.spawnError) {
    facts.push(`无法启动 pi：${redactLocalDiagnostic(info.spawnError, 300) ?? info.spawnError}`)
  } else {
    const bits: string[] = []
    if (info.code !== undefined) bits.push(`code=${info.code ?? 'null'}`)
    if (info.signal !== undefined) bits.push(`signal=${info.signal ?? 'null'}`)
    if (bits.length) facts.push(`pi 子进程提前退出（${bits.join('，')}）`)
  }
  const tail = stderrTail.length ? `；stderr：${stderrTail.join(' | ')}` : ''
  return `${facts.join('；') || 'pi 子进程提前退出'}${tail}`
}
const STREAM_PUSH_MS = 33
export interface SubagentRpc {
  readonly running: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  spawn(): void
  command(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<{ success: boolean; error?: string; data?: unknown }>
  close(): Promise<void>
}

interface Run extends SubagentRun {
  rpc: SubagentRpc
  timer: NodeJS.Timeout
  pushTimer?: NodeJS.Timeout
  lastProgressAt: number
  activeSince: number
  activation: number
  resumed?: boolean
  baseUsage?: SubagentUsageTotals
  runningTools: Set<string>
  totalMs?: number
  idleMs: number
  graceMs: number
  settled: boolean
  retryAttempt?: number
  retryMaxAttempts?: number
  lastModelErrorText?: string
  workspace: PreparedWorkspace
  finalizing?: Promise<void>
  settling?: Promise<void>
  worktreeDone?: boolean
  notified?: boolean
  reviewDecided?: boolean
  msgSeq: number
  streamingId?: string
  resultKey?: string
  stopReason?: string
  usageSnapshots: UsageSnapshots
  contextRevision?: number
  contextRefresh?: Promise<void>
  brief: SubagentBrief
  stderrTail: string[]
  forkSource?: SubagentForkSource
  exitInfo?: { code: number | null; signal: string | null; spawnError?: string }
}

export interface SubagentApprovalOrigin { sessionId?: string; runId?: string; subagentId?: string }
const READ_ONLY_HOST_COMMANDS = ['search.query', 'search.fetch']

export interface SubagentDangerAnswer { decision: 'allow' | 'deny' | 'no-answer'; feedback?: string }

const NO_APPROVAL_ANSWER: SubagentDangerAnswer = { decision: 'no-answer' }

export function dangerConfirmSummary(answer: boolean | SubagentDangerAnswer | undefined): { allowed: boolean; decision: SubagentDangerAnswer['decision']; feedback?: string } {
  if (answer === undefined || typeof answer === 'boolean') return { allowed: answer === true, decision: answer === true ? 'allow' : answer === false ? 'deny' : 'no-answer' }
  return { allowed: answer.decision === 'allow', decision: answer.decision, ...(answer.decision === 'deny' && answer.feedback ? { feedback: answer.feedback } : {}) }
}

export function awaitApprovalAnswer(
  pending: Promise<boolean | SubagentDangerAnswer>,
  signals: readonly (AbortSignal | undefined)[]
): Promise<boolean | SubagentDangerAnswer> {
  const live = signals.filter((signal): signal is AbortSignal => !!signal)
  if (!live.length) return pending
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      for (const signal of live) signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      resolve(NO_APPROVAL_ANSWER)
    }
    for (const signal of live) {
      if (signal.aborted) {
        onAbort()
        return
      }
    }
    for (const signal of live) signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (answer) => {
        cleanup()
        resolve(answer)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export interface SubagentContext {
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  projectId?: string
}

export type SubagentSendMode = 'steer' | 'followUp'
export type SubagentSendFrom = 'parent' | 'user'
export interface SubagentSendResult { ok: boolean; error?: string; run?: SubagentRun; delivery?: 'queued' | 'started' | 'resumed' }

export interface SubagentOptions {
  cwd: string
  piBin?: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  projectId?: string
  archiveDir?: string
  previewHtml?: PreviewHtml
  confirmDanger?(
    params: Record<string, unknown>,
    cwd: string,
    origin?: SubagentApprovalOrigin,
    signal?: AbortSignal
  ): Promise<boolean | SubagentDangerAnswer>
  resolveModelApi?(label: string, origin: { sessionId?: string; runId?: string }): Promise<string | undefined>
  extensions?: string[]
  readOnlyExtension?: string
  runReadOnlyCommand?(command: string, params: Record<string, unknown>, cwd: string): Promise<CapabilityCommandResult>
  appendSystemPrompt?: string
  onChange: (run: SubagentRun) => void
  onPatch?: (payload: { id: string; run: SubagentRun; transcriptFrom: number }) => void
  onRemove?: (id: string) => void
  onFinished?: (run: SubagentRun) => void
  onEvent?: (runId: string, evt: Record<string, unknown>, run: SubagentRun) => void
  createRpc?: (opts: { cwd: string; piBin?: string; args: string[] }) => SubagentRpc
  prepare?: (rootCwd: string, id: string, isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd') => Promise<PreparedWorkspace>
}

export interface SubagentHostCommands {
  onlyCommands: string[]
  handle(command: string, params: Record<string, unknown>, cwd: string): Promise<CapabilityCommandResult | undefined>
}

export function subagentHostCommands(opts: {
  readOnlyHost?: SubagentOptions['runReadOnlyCommand']
  previewHtml?: PreviewHtml
}): SubagentHostCommands {
  const onlyCommands = ['danger.confirm', ...(opts.readOnlyHost ? READ_ONLY_HOST_COMMANDS : []), ...(opts.previewHtml ? ['artifact.preview'] : [])]
  return {
    onlyCommands,
    handle: async (command, params, cwd) => {
      if (opts.readOnlyHost && READ_ONLY_HOST_COMMANDS.includes(command)) return opts.readOnlyHost(command, params, cwd)
      if (command === 'artifact.preview') return runArtifactPreview(opts.previewHtml, params.path, cwd, params.at)
      return undefined
    }
  }
}

export class SubagentController {
  private runs = new Map<string, Run>()
  private pushedTranscript = new Map<string, { length: number; firstId: string; lastId: string }>()
  private preparing = 0
  private launchGeneration = 0
  private pendingLaunches = new Set<Promise<void>>()
  private resuming = new Map<string, { cancelled: boolean }>()
  private activationSeq = 0
  private stoppingAll?: Promise<void>
  private opts: SubagentOptions
  private history: SubagentHistory

  constructor(opts: SubagentOptions) {
    this.opts = opts
    this.history = new SubagentHistory(opts.archiveDir ?? join(YAN_DIR, 'subagents'))
  }

  async loadHistory(): Promise<void> {
    await this.history.load()
  }

  setContext(context: SubagentContext): void {
    const { cwd, parentSessionId, parentRunId, parentGeneration, parentMessageId, projectId } = context
    this.opts = { ...this.opts, cwd, parentSessionId, parentRunId, parentGeneration, parentMessageId, projectId }
  }

  adoptParentSession(input: {
    parentRunId: string
    parentGeneration?: number
    fromSessionId: string
    toSessionId: string
  }): SubagentRun[] {
    const { parentRunId, parentGeneration, fromSessionId, toSessionId } = input
    if (!parentRunId || !fromSessionId || !toSessionId) return []
    if (parentGeneration === undefined) return []
    if (fromSessionId !== `pending:${parentRunId}`) return []
    if (fromSessionId === toSessionId || toSessionId.startsWith('pending:')) return []
    const changed: SubagentRun[] = []
    for (const run of this.runs.values()) {
      if (run.parentRunId !== parentRunId) continue
      if (run.parentGeneration !== parentGeneration) continue
      if (run.parentSessionId !== fromSessionId) continue
      run.parentSessionId = toSessionId
      this.emit(run)
      changed.push(this.snapshot(run))
    }
    return changed
  }

  private snapshot(run: Run): SubagentRun {
    return {
      id: run.id,
      task: run.task,
      cwd: run.cwd,
      parentSessionId: run.parentSessionId,
      parentRunId: run.parentRunId,
      parentGeneration: run.parentGeneration,
      parentMessageId: run.parentMessageId,
      projectId: run.projectId,
      isolation: run.isolation,
      ...(run.fork ? { fork: true } : {}),
      resultPath: run.resultPath,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      contextUsage: run.contextUsage,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      endReason: run.endReason,
      ...(run.launchFailed ? { launchFailed: true } : {}),
      dismissedAt: run.dismissedAt,
      toolCalls: run.toolCalls,
      wrapUp: run.wrapUp,
      recovery: run.recovery,
      latestActivity: run.latestActivity,
      progressWarning: run.progressWarning,
      transcript: run.transcript,
      diff: run.diff,
      review: run.review,
      error: run.error,
      usage: run.usage,
      brief: run.brief,
      result: this.resultOf(run)
    }
  }

  private emit(run: Run): void {
    clearTimeout(run.pushTimer)
    run.pushTimer = undefined
    if (this.runs.get(run.id) !== run) return
    try {
      this.opts.onChange(this.snapshot(run))
    } catch (error) {
      console.warn('[subagent] 推送子代理状态失败', error)
    }
    this.rememberPushedTranscript(run)
  }

  private resultOf(run: Run): NonNullable<SubagentRun['result']> {
    const last = run.transcript[run.transcript.length - 1]
    const key = [
      run.transcript.length,
      last?.id ?? '',
      last?.text.length ?? 0,
      last?.toolCalls?.length ?? 0,
      run.diff?.files ?? 0,
      run.diff?.patchPath ?? '',
      run.resultPath ?? '',
      run.error ?? ''
    ].join('|')
    if (run.resultKey !== key || !run.result) {
      run.resultKey = key
      run.result = summarizeSubagentRun(
        {
          transcript: run.transcript,
          diffPaths: run.diff?.paths,
          resultPath: run.resultPath,
          error: run.error,
          status: run.status
        },
        run.endedAt ?? run.startedAt
      )
    }
    return run.result
  }

  private rememberPushedTranscript(run: Run): void {
    const transcript = run.transcript
    if (!transcript.length) {
      this.pushedTranscript.delete(run.id)
      return
    }
    this.pushedTranscript.set(run.id, {
      length: transcript.length,
      firstId: transcript[0].id,
      lastId: transcript[transcript.length - 1].id
    })
  }

  private emitDelta(run: Run): void {
    const previous = this.pushedTranscript.get(run.id)
    const transcript = run.transcript
    const onPatch = this.opts.onPatch
    const sameBase =
      previous !== undefined &&
      previous.length > 0 &&
      previous.length <= transcript.length &&
      transcript[0]?.id === previous.firstId &&
      transcript[previous.length - 1]?.id === previous.lastId
    if (!sameBase || !onPatch) {
      this.emit(run)
      return
    }
    clearTimeout(run.pushTimer)
    run.pushTimer = undefined
    const transcriptFrom = previous.length - 1
    try {
      onPatch({ id: run.id, run: { ...this.snapshot(run), transcript: transcript.slice(transcriptFrom) }, transcriptFrom })
    } catch (error) {
      console.warn('[subagent] 推送子代理增量失败', error)
      return
    }
    this.rememberPushedTranscript(run)
  }

  private emitStream(run: Run): void {
    if (run.pushTimer) return
    run.pushTimer = setTimeout(() => {
      run.pushTimer = undefined
      if (this.runs.get(run.id) === run) this.emitDelta(run)
    }, STREAM_PUSH_MS)
  }

  list(): SubagentRun[] {
    const historical = this.history.list().filter(({ run }) => !this.runs.has(run.id)).map(({ run }) => run)
    return [...historical, ...[...this.runs.values()].map((r) => this.snapshot(r))].sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): SubagentRun | undefined {
    const run = this.runs.get(id)
    return run ? this.snapshot(run) : this.history.get(id)?.run
  }

  hasParentRun(sessionId: string | undefined, runId: string): boolean {
    const matches = (run: { parentSessionId?: string; parentRunId?: string }): boolean =>
      (!!sessionId && run.parentSessionId === sessionId) || run.parentRunId === runId
    return [...this.runs.values()].some(matches) || this.history.list().some(({ run }) => matches(run))
  }

  runningSiblings(input: { parentSessionId?: string; parentRunId?: string }): number {
    const { parentSessionId, parentRunId } = input
    if (!parentSessionId && !parentRunId) return 0
    let count = 0
    for (const run of this.runs.values()) {
      if (run.status !== 'running' && run.status !== 'starting') continue
      if ((!!parentSessionId && run.parentSessionId === parentSessionId) || (!!parentRunId && run.parentRunId === parentRunId)) count += 1
    }
    return count
  }

  get runningCount(): number {
    const live = [...this.runs.values()].filter((r) => r.status === 'running' || r.status === 'starting').length
    return live + this.preparing
  }

  async clearFinished(): Promise<void> {
    for (const run of [...this.runs.values()]) {
      if (run.status === 'running' || run.status === 'starting') continue
      if (run.settling) { try { await run.settling } catch { } }
      if (run.finalizing) { try { await run.finalizing } catch { } }
    }
    for (const run of this.list()) {
      if (run.status === 'running' || run.status === 'starting' || this.resuming.has(run.id)) continue
      if (run.review === 'pending' || run.review === 'conflict') continue
      const live = this.runs.get(run.id)
      if (live && !live.reviewDecided) continue
      const rootCwd = live?.workspace.rootCwd ?? this.history.get(run.id)?.rootCwd ?? run.cwd
      const activation = live?.activation
      await this.history.hide(run, rootCwd)
      const current = this.runs.get(run.id)
      if (current !== live || this.resuming.has(run.id) || (live && (live.status === 'running' || live.status === 'starting' || live.activation !== activation))) {
        await this.history.unhide(current ? this.snapshot(current) : run, rootCwd).catch((error: unknown) => console.warn('[subagent] 恢复子代理记录失败', error))
        continue
      }
      clearTimeout(live?.pushTimer)
      this.runs.delete(run.id)
      this.pushedTranscript.delete(run.id)
      this.opts.onRemove?.(run.id)
    }
  }

  async dismiss(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const live = this.runs.get(id)
      if (live?.settling) await live.settling
      if (live?.finalizing) await live.finalizing
      const entry = this.history.get(id)
      const run = this.runs.get(id)
      const snapshot = run ? this.snapshot(run) : entry?.run
      if (!snapshot) return { ok: false, error: '找不到这个子代理' }
      if (snapshot.status !== 'error') return { ok: false, error: '只能对已失败的子代理选择不再处理' }
      if (snapshot.review === 'pending' || snapshot.review === 'conflict' || (run && !run.reviewDecided)) {
        return { ok: false, error: '请先审阅并合并或明确放弃该子代理的改动' }
      }
      if (typeof snapshot.dismissedAt === 'number' && Number.isFinite(snapshot.dismissedAt)) return { ok: true }
      const next = { ...snapshot, dismissedAt: Date.now() }
      await this.history.save(next, run?.workspace.rootCwd ?? entry?.rootCwd ?? snapshot.cwd, {
        ...(run ? { limits: { totalMs: run.totalMs, stallTimeoutMs: run.idleMs, graceMs: run.graceMs } } : {}),
        patchPath: snapshot.diff?.patchPath
      })
      if (run && this.runs.get(id) === run) {
        run.dismissedAt = next.dismissedAt
        this.emit(run)
      } else {
        const saved = this.history.get(id)?.run
        if (saved) this.opts.onChange(saved)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `未能保存处理标记：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async start(
    task: string,
    model?: string,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd' = 'shared-cwd',
    briefInput?: unknown,
    fork?: SubagentForkSource,
    context?: SubagentContext
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    if (fork && isolation !== 'shared-cwd') return { ok: false, error: 'fork 子代理只能在当前目录运行' }
    if (this.stoppingAll) return { ok: false, error: '子代理正在停止清理，请稍后重试' }
    const text = task.trim()
    if (!text) return { ok: false, error: '任务描述为空' }
    const modelError = subagentModelError(model ?? process.env.YAN_TEST_MODEL, isolation === 'controlled-cwd')
    if (modelError) return { ok: false, error: modelError }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: `同时最多运行 ${MAX_CONCURRENT} 个子代理（当前 ${this.runningCount} 个），先等一个结束或停掉它` }
    }
    const parsed = parseSubagentBrief(briefInput, text)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const ctx: SubagentOptions = context ? { ...this.opts, ...context } : this.opts
    const generation = this.launchGeneration
    this.preparing += 1
    let reserved = true
    const releasePreparing = () => {
      if (!reserved) return
      reserved = false
      this.preparing -= 1
    }
    let settleLaunch: () => void = () => {}
    const pendingLaunch = new Promise<void>((resolve) => { settleLaunch = () => resolve() })
    this.pendingLaunches.add(pendingLaunch)
    try {
      return await this.launch(ctx, text, fork?.model ?? model, isolation, parsed.brief, releasePreparing, generation, fork)
    } finally {
      releasePreparing()
      this.pendingLaunches.delete(pendingLaunch)
      settleLaunch()
    }
  }

  private async launch(
    ctx: SubagentOptions,
    text: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    brief: SubagentBrief,
    releasePreparing: () => void,
    generation: number,
    fork?: SubagentForkSource
  ): Promise<{ ok: boolean; error?: string; run?: SubagentRun }> {
    const id = `sub-${randomBytes(4).toString('hex')}`
    const invalidated = (): boolean => generation !== this.launchGeneration
    let workspace: PreparedWorkspace
    try {
      const prepare = ctx.prepare ?? prepareWorkspace
      workspace = await prepare(ctx.cwd, id, isolation)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (invalidated()) {
      await cleanupWorkspace(workspace)
      return { ok: false, error: '子代理在启动期间已停止' }
    }

    let rpc: SubagentRpc
    try {
      rpc = await this.createRpc(ctx, workspace.cwd, model, isolation, id, undefined, fork)
    } catch (error) {
      await cleanupWorkspace(workspace)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (invalidated()) {
      try { await rpc.close() } catch { }
      await cleanupWorkspace(workspace)
      return { ok: false, error: '子代理在启动期间已停止' }
    }

    const run: Run = {
      id,
      task: text,
      cwd: workspace.cwd,
      parentSessionId: ctx.parentSessionId,
      parentRunId: ctx.parentRunId,
      parentGeneration: ctx.parentGeneration,
      parentMessageId: ctx.parentMessageId,
      projectId: ctx.projectId,
      isolation: workspace.isolation,
      ...(fork ? { fork: true, forkSource: fork } : {}),
      model,
      status: 'starting',
      startedAt: Date.now(),
      activeSince: Date.now(),
      activation: ++this.activationSeq,
      latestActivity: '启动中…',
      transcript: [],
      review: 'none',
      usageSnapshots: {},
      brief,
      stderrTail: [],
      rpc,
      workspace,
      settled: false,
      msgSeq: 0,
      toolCalls: 0,
      lastProgressAt: Date.now(),
      runningTools: new Set(),
      ...limitsFor(brief),
      timer: setTimeout(() => undefined, 0)
    }
    clearTimeout(run.timer)
    this.armWatch(run)
    this.wireRpc(run, rpc)

    this.runs.set(id, run)
    releasePreparing()
    await this.writeMetadata(run)
    this.emit(run)

    try {
      if (run.status !== 'starting') return this.startupAbort(run)
      rpc.spawn()
      const ready = await this.waitReady(rpc, 20_000)
      if (run.status !== 'starting') return this.startupAbort(run)
      if (!ready.ok) {
        await this.fail(id, '子代理启动超时', 'startup')
        return { ok: false, error: this.runs.get(id)?.error ?? '子代理启动超时' }
      }
      if (model && ready.model && modelMismatch(model, ready.model)) {
        const message = `指定的模型 ${model} 没有生效（pi 实际使用 ${ready.model}），请核对模型名与登录状态后重试，不要改用其他模型`
        await this.fail(id, message, 'startup')
        return { ok: false, error: message }
      }
      if (model && ready.model) {
        const expectedApi = await ctx.resolveModelApi?.(ready.model, { sessionId: ctx.parentSessionId, runId: ctx.parentRunId })
        if (run.status !== 'starting') return this.startupAbort(run)
        const selectionError = await confirmRegisteredModel(rpc, ready.model, { readOnly: isolation === 'controlled-cwd', expectedApi })
        if (run.status !== 'starting') return this.startupAbort(run)
        if (selectionError) {
          await this.fail(id, selectionError, 'startup')
          return { ok: false, error: selectionError }
        }
      }
      if (ready.model) run.model = ready.model
      if (ready.thinkingLevel) run.thinkingLevel = ready.thinkingLevel
      run.status = 'running'
      run.latestActivity = '已启动'
      await this.writeMetadata(run)
      if (run.status !== 'running') return this.startupAbort(run)
      this.emit(run)

      const res = await rpc.command('prompt', { message: fork ? forkPrompt(briefPrompt(brief, text)) : briefPrompt(brief, text) })
      if (!res.success) {
        await this.fail(id, res.error ?? '启动任务失败')
        return { ok: false, error: res.error ?? '启动任务失败' }
      }
      return { ok: true, run: this.snapshot(run) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const realReason = run.status === 'error' && run.endReason === 'exited' ? run.error : undefined
      if (!realReason) await this.fail(id, message)
      return { ok: false, error: realReason ?? message }
    }
  }

  private wireRpc(run: Run, rpc: SubagentRpc): void {
    const current = (): boolean => run.rpc === rpc
    rpc.on('event', (evt: Record<string, unknown>) => { if (current()) this.handleEvent(run, evt) })
    rpc.on('stderr', (line: string) => {
      if (!current()) return
      const safe = sanitizeStderrLine(line)
      if (!safe) return
      run.stderrTail.push(safe)
      if (run.stderrTail.length > MAX_STDERR_LINES) run.stderrTail.shift()
    })
    rpc.on('spawn-error', (err: Error) => {
      if (!current()) return
      const raw = err instanceof Error ? err.message : String(err)
      run.exitInfo = { code: null, signal: null, spawnError: redactLocalDiagnostic(raw, 300) ?? '未知启动错误' }
      this.handleProcessGone(run)
    })
    rpc.on('exit', (code: number | null, signal: string | null) => {
      if (!current()) return
      run.exitInfo = { ...(run.exitInfo ?? {}), code, signal }
      this.handleProcessGone(run)
    })
  }

  private sessionDir(id: string): string {
    return join(this.opts.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id)
  }

  private async createRpc(
    ctx: SubagentOptions,
    cwd: string,
    model: string | undefined,
    isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd',
    id: string,
    sessionFile?: string,
    fork?: SubagentForkSource
  ): Promise<SubagentRpc> {
    if (fork) return this.createForkRpc(ctx, id, fork, sessionFile)
    let version: string | undefined
    try { const probe = resolvePi({ override: ctx.piBin }); if (probe.home) version = JSON.parse(readFileSync(join(probe.home, 'package.json'), 'utf8')).version } catch { }
    const args = subagentPiArgs({ sessionDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id), sessionFile, native: nativePiToolsSupported(version), readOnly: isolation === 'controlled-cwd', model: model ?? process.env.YAN_TEST_MODEL, systemPrompt: ctx.appendSystemPrompt, extensions: ctx.extensions, readOnlyExtension: ctx.readOnlyExtension })
    if (ctx.createRpc) return ctx.createRpc({ cwd, piBin: ctx.piBin, args })
    return this.spawnWithApproval(ctx, id, cwd, ctx.piBin, args, { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR }, ctx.runReadOnlyCommand)
  }

  private async createForkRpc(ctx: SubagentOptions, id: string, fork: SubagentForkSource, sessionFile?: string): Promise<SubagentRpc> {
    const sessionDir = join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id)
    const file = sessionFile ?? (await writeForkSession(fork.sessionFile, sessionDir)).file
    const args = forkPiArgs(fork.args, { sessionDir, sessionFile: file, model: fork.model, thinkingLevel: fork.thinkingLevel })
    const piBin = fork.piBin ?? ctx.piBin
    if (ctx.createRpc) return ctx.createRpc({ cwd: fork.cwd, piBin, args })
    return this.spawnWithApproval(ctx, id, fork.cwd, piBin, args, { ...fork.env, YAN_RUNNER_ID: id }, ctx.runReadOnlyCommand)
  }

  private async spawnWithApproval(
    ctx: SubagentOptions,
    id: string,
    cwd: string,
    piBin: string | undefined,
    args: string[],
    env: Record<string, string | undefined>,
    readOnlyHost?: SubagentOptions['runReadOnlyCommand']
  ): Promise<SubagentRpc> {
    const stopApprovals = new AbortController()
    const host = subagentHostCommands({ readOnlyHost, previewHtml: ctx.previewHtml })
    const approval = new CapabilityServer({
      opsDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'approvals', id),
      onlyCommands: host.onlyCommands,
      handlers: {
        run: async (command, params, _context, signal) => {
          const handled = await host.handle(command, params, cwd)
          if (handled) return handled
          const origin = { sessionId: ctx.parentSessionId, runId: ctx.parentRunId, subagentId: id }
          const answer = ctx.confirmDanger && !signal?.aborted && !stopApprovals.signal.aborted
            ? await awaitApprovalAnswer(ctx.confirmDanger(params, cwd, origin, signal), [signal, stopApprovals.signal])
            : undefined
          return { summary: { kind: 'danger-confirm', ...dangerConfirmSummary(answer) } }
        }
      }
    })
    const halt = (): void => {
      if (!stopApprovals.signal.aborted) stopApprovals.abort()
      approval.stop()
    }
    try {
      const endpoint = await approval.start({ sessionId: id, projectId: ctx.projectId ?? id })
      const rpc = new PiRpc({
        cwd, piBin, args,
        env: { ...env,
          PATH: `${join(YAN_DIR, 'bin')}${delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
          YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token,
          YAN_SESSION_ID: id, YAN_PROJECT_ID: ctx.projectId ?? id }
      })
      rpc.on('exit', () => halt())
      rpc.on('ui', (req: Record<string, unknown>) => {
        const requestId = typeof req.id === 'string' ? req.id : ''
        if (requestId && DIALOG_UI_METHODS.has(String(req.method ?? ''))) rpc.respondUi({ id: requestId, cancelled: true })
      })
      const close = rpc.close.bind(rpc)
      rpc.close = async () => { halt(); await close() }
      return rpc
    } catch (error) {
      halt()
      throw error
    }
  }

  async send(
    id: string,
    message: string,
    mode: SubagentSendMode = 'steer',
    origin: { parentSessionId?: string; from?: SubagentSendFrom } = {}
  ): Promise<SubagentSendResult> {
    const text = message.trim()
    if (!text) return { ok: false, error: '追加内容为空' }
    const from = origin.from ?? 'parent'
    const live = this.runs.get(id)
    const snapshot = live ? this.snapshot(live) : this.history.get(id)?.run
    if (!snapshot) return { ok: false, error: '找不到这个子代理' }
    if (from === 'parent' && snapshot.parentSessionId && origin.parentSessionId !== snapshot.parentSessionId) {
      return { ok: false, error: '只能向本会话派出的子代理追加信息' }
    }
    if (this.resuming.has(id) || live?.status === 'starting') return { ok: false, error: '子代理正在启动，稍后再发' }
    if (!live || live.status !== 'running' || live.settled) return this.resume(id, text, from)
    if (live.wrapUp || live.settling || live.finalizing) return { ok: false, error: '子代理正在收尾，等它结束后再发即可续接' }
    const activation = live.activation
    const current = (): boolean => this.runs.get(id) === live && live.activation === activation && live.status === 'running' && !live.settled && !live.settling
    try {
      const res = await live.rpc.command('prompt', { message: forwardedMessage(text, mode, from), streamingBehavior: mode }, { timeoutMs: 10_000 })
      if (!res.success) return { ok: false, error: res.error ?? '追加信息没有送达' }
      if (!current()) return { ok: false, error: '子代理在发送期间已结束，这条信息可能没有被处理；请再发一次以续接' }
      const disposition = (res.data as { disposition?: unknown } | undefined)?.disposition
      const delivery = disposition === 'queued' ? 'queued' : 'started'
      live.lastProgressAt = Date.now()
      live.latestActivity = delivery === 'queued'
        ? (mode === 'steer' ? '已收到追加信息，当前工具结束后处理' : '已收到追加信息，当前任务做完后处理')
        : '已收到追加信息'
      this.armWatch(live)
      this.emit(live)
      return { ok: true, run: this.snapshot(live), delivery }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async resume(id: string, text: string, from: SubagentSendFrom): Promise<SubagentSendResult> {
    if (this.stoppingAll) return { ok: false, error: '子代理正在停止清理，请稍后重试' }
    if (this.runningCount >= MAX_CONCURRENT) return { ok: false, error: `同时最多运行 ${MAX_CONCURRENT} 个子代理（当前 ${this.runningCount} 个），先等一个结束或停掉它` }
    const ticket = { cancelled: false }
    const generation = this.launchGeneration
    this.resuming.set(id, ticket)
    this.preparing += 1
    let reserved = true
    const release = (): void => {
      if (!reserved) return
      reserved = false
      this.preparing -= 1
    }
    let settleLaunch: () => void = () => {}
    const pendingLaunch = new Promise<void>((resolve) => { settleLaunch = () => resolve() })
    this.pendingLaunches.add(pendingLaunch)
    const previous = this.runs.get(id)
    const abandoned = (): boolean =>
      ticket.cancelled || generation !== this.launchGeneration ||
      (previous ? this.runs.get(id) !== previous : !this.history.get(id))
    const abandonedError = (): SubagentSendResult => ({ ok: false, error: ticket.cancelled ? '续接已被停止' : '子代理已被停止或清理，没有续接' })
    try {
      if (previous?.settling) await previous.settling.catch(() => undefined)
      if (previous?.finalizing) await previous.finalizing.catch(() => undefined)
      if (abandoned()) return abandonedError()
      const record = this.history.get(id)
      const snapshot = previous ? this.snapshot(previous) : record?.run
      if (!snapshot) return { ok: false, error: '找不到这个子代理' }
      if (snapshot.status === 'running' || snapshot.status === 'starting') {
        if (previous) return { ok: false, error: '子代理仍在运行，请再发一次' }
        return { ok: false, error: '这个子代理上次运行被中断，不能续接；需要继续时重新派一个，并在任务里附上它的结论' }
      }
      if (snapshot.isolation === 'worktree') {
        return { ok: false, error: 'worktree 子代理结束后不能续接：请先审阅它的改动；需要继续时重新派一个，并在任务里附上它的结论' }
      }
      if (snapshot.launchFailed) return { ok: false, error: '这个子代理没有成功启动过，不能续接，请重新派一个' }
      const forkSource = previous?.forkSource
      if (snapshot.fork && !forkSource) return { ok: false, error: 'fork 子代理在砚重启后不能续接；需要继续时重新派一个' }
      const sessionFile = await latestSessionFile(this.sessionDir(id))
      if (abandoned()) return abandonedError()
      if (!sessionFile) return { ok: false, error: '找不到它的会话记录，不能续接；需要继续时重新派一个，并在任务里附上它的结论' }

      const rootCwd = previous?.workspace.rootCwd ?? record?.rootCwd ?? snapshot.cwd
      const workspace: PreparedWorkspace = previous?.workspace ?? { isolation: snapshot.isolation, rootCwd, cwd: snapshot.cwd }
      const ctx: SubagentOptions = { ...this.opts, parentSessionId: snapshot.parentSessionId, parentRunId: snapshot.parentRunId, parentGeneration: snapshot.parentGeneration, parentMessageId: snapshot.parentMessageId, projectId: snapshot.projectId }
      let brief: SubagentBrief
      let rpc: SubagentRpc
      try {
        brief = previous?.brief ?? resumeBrief(snapshot)
        rpc = await this.createRpc(ctx, workspace.cwd, snapshot.model, workspace.isolation, id, sessionFile, forkSource)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (abandoned()) {
        await rpc.close().catch(() => undefined)
        return abandonedError()
      }

      const now = Date.now()
      const activation = ++this.activationSeq
      const run: Run = previous ?? {
        ...snapshot,
        rpc,
        timer: setTimeout(() => undefined, 0),
        lastProgressAt: now,
        activeSince: now,
        activation,
        runningTools: new Set(),
        ...limitsFor(brief),
        settled: false,
        workspace,
        msgSeq: lastMessageSeq(snapshot.transcript),
        usageSnapshots: {},
        baseUsage: snapshot.usage,
        brief,
        stderrTail: []
      }
      clearTimeout(run.timer)
      Object.assign(run, {
        rpc, activation, status: 'starting', settled: false, resumed: true, activeSince: now, lastProgressAt: now,
        latestActivity: '正在续接…', stderrTail: [], runningTools: new Set<string>(),
        contextRevision: (run.contextRevision ?? 0) + 1, diff: undefined, resultPath: undefined,
        settling: undefined, finalizing: undefined, notified: false, reviewDecided: false, worktreeDone: false,
        endedAt: undefined, endReason: undefined, error: undefined, stopReason: undefined, wrapUp: undefined,
        progressWarning: undefined, recovery: undefined, retryAttempt: undefined, retryMaxAttempts: undefined,
        lastModelErrorText: undefined, exitInfo: undefined, streamingId: undefined, dismissedAt: undefined
      })
      this.runs.set(id, run)
      release()
      this.wireRpc(run, rpc)
      this.armWatch(run)
      this.emit(run)

      const current = (status: SubagentRun['status']): boolean => run.rpc === rpc && run.activation === activation && run.status === status
      const stoppedError = (): SubagentSendResult => ({ ok: false, error: run.error ?? '子代理在续接期间已停止，这条信息没有被处理' })
      try {
        rpc.spawn()
        const ready = await this.waitReady(rpc, 20_000)
        if (!current('starting')) return stoppedError()
        if (ticket.cancelled || generation !== this.launchGeneration) {
          await this.stopRun(run, false)
          return abandonedError()
        }
        if (!ready.ok) {
          await this.fail(id, '子代理续接超时', 'startup')
          return { ok: false, error: this.runs.get(id)?.error ?? '子代理续接超时' }
        }
        if (snapshot.model && ready.model && modelMismatch(snapshot.model, ready.model)) {
          const error = `续接时模型 ${snapshot.model} 没有生效（pi 实际使用 ${ready.model}），请核对登录状态后重试`
          await this.fail(id, error, 'startup')
          return { ok: false, error }
        }
        if (ready.thinkingLevel) run.thinkingLevel = ready.thinkingLevel
        run.status = 'running'
        run.resumed = false
        run.latestActivity = '已续接'
        await this.writeMetadata(run)
        if (!current('running')) return stoppedError()
        this.emit(run)
        const res = await rpc.command('prompt', { message: forwardedMessage(text, 'resume', from) }, { timeoutMs: 10_000 })
        if (!current('running')) return stoppedError()
        if (!res.success) {
          await this.fail(id, res.error ?? '续接后发送信息失败')
          return { ok: false, error: res.error ?? '续接后发送信息失败' }
        }
        return { ok: true, run: this.snapshot(run), delivery: 'resumed' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (run.activation === activation && (run.status === 'starting' || run.status === 'running')) await this.fail(id, message)
        return { ok: false, error: run.error ?? message }
      }
    } finally {
      release()
      if (this.resuming.get(id) === ticket) this.resuming.delete(id)
      this.pendingLaunches.delete(pendingLaunch)
      settleLaunch()
    }
  }

  async stop(id: string): Promise<SubagentStopResult> {
    const ticket = this.resuming.get(id)
    if (ticket) ticket.cancelled = true
    const run = this.runs.get(id)
    if (!run) return ticket || this.history.get(id) ? { ok: true } : { ok: false, error: '找不到这个子代理' }
    if (run.status !== 'running' && run.status !== 'starting') return { ok: true, noop: true, before: run.status }
    await this.stopRun(run, false)
    return { ok: true }
  }

  private async stopRun(run: Run, cleanupReview: boolean): Promise<void> {
    if (run.settling) {
      try { await run.settling } catch { }
      if (run.status !== 'running' && run.status !== 'starting') {
        if (cleanupReview) await this.finalize(run, true)
        return
      }
    }
    run.status = 'cancelled'
    run.endReason = 'stopped'
    run.error = undefined
    const settling = (async () => {
      try {
        await run.rpc.command('abort', undefined, { timeoutMs: ABORT_TIMEOUT_MS })
      } catch {
      }
      clearTimeout(run.timer)
      await run.rpc.close()
      run.status = 'cancelled'
      run.endReason = 'stopped'
      run.wrapUp = undefined
      run.endedAt = Date.now()
      run.latestActivity = '已停止'
      this.emit(run)
      await this.finalize(run, cleanupReview)
    })()
    run.settling = settling
    await settling
  }

  stopAll(): Promise<void> {
    if (this.stoppingAll) return this.stoppingAll
    this.launchGeneration += 1
    const task = Promise.resolve().then(() => this.drainAll())
    this.stoppingAll = task
    void task.finally(() => { if (this.stoppingAll === task) this.stoppingAll = undefined }).catch(() => {})
    return task
  }

  private async drainAll(): Promise<void> {
    const pending = [...this.pendingLaunches]
    const runs = [...this.runs.values()]
    let next = 0
    let failure: unknown
    const settleRun = async (run: Run): Promise<void> => {
      if (run.status === 'running' || run.status === 'starting') await this.stopRun(run, true)
      else {
        if (run.settling) await run.settling
        else await run.rpc.close()
        await this.finalize(run, true)
      }
    }
    const worker = async (): Promise<void> => {
      while (next < runs.length) {
        const run = runs[next]
        next += 1
        try {
          await settleRun(run)
        } catch (error) {
          failure ??= error
        }
      }
    }
    const width = Math.min(DRAIN_CONCURRENCY, runs.length)
    await Promise.all(Array.from({ length: width }, worker))
    await Promise.all(pending)
    if (failure) throw failure
  }

  private handleProcessGone(run: Run): void {
    if (run.status !== 'running' && run.status !== 'starting') return
    clearTimeout(run.timer)
    if (run.status === 'starting' && !run.resumed) run.launchFailed = true
    run.status = 'error'
    run.endReason = 'exited'
    run.wrapUp = undefined
    run.error = run.error ?? describeProcessExit(run.exitInfo ?? {}, run.stderrTail)
    run.endedAt = Date.now()
    this.emit(run)
    void this.finalize(run, false).catch((error) => console.warn('[subagent] 收尾失败', error))
  }

  private startupAbort(run: Run): { ok: false; error: string } {
    return { ok: false, error: run.status === 'error' && run.error ? run.error : '子代理在启动期间已停止' }
  }

  private async fail(id: string, message: string, reason: SubagentEndReason = 'failed'): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    if (run.status === 'done' || run.status === 'error' || run.settling) return
    clearTimeout(run.timer)
    if (run.status === 'starting' && !run.resumed) run.launchFailed = true
    const cancelled = run.status === 'cancelled'
    run.status = cancelled ? 'cancelled' : 'error'
    run.endReason = cancelled ? 'stopped' : reason
    run.wrapUp = undefined
    run.progressWarning = undefined
    if (cancelled) {
      run.error = undefined
      run.latestActivity = '已停止'
    } else {
      run.error = reason === 'startup' && run.stderrTail.length ? `${message}；stderr：${run.stderrTail.join(' | ')}` : message
      run.latestActivity = message
    }
    run.endedAt = Date.now()
    this.emit(run)
    const settling = (async () => {
      try {
        await run.rpc.close()
      } catch (error) {
        console.warn('[subagent] 关闭子代理进程失败', error)
      }
      await this.finalize(run, false)
    })()
    if (!run.settling) run.settling = settling
    await settling
  }

  private async finalize(run: Run, cleanupReview: boolean): Promise<void> {
    if (!run.finalizing) run.finalizing = this.finalizeOnce(run, cleanupReview)
    await run.finalizing
    if (cleanupReview) await this.archiveOnExit(run)
  }

  private async finalizeOnce(run: Run, cleanupReview: boolean): Promise<void> {
    try {
      const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
      const collected = await collectDiff(run.workspace, archiveDir, run.id)
      run.diff = collected.summary
      const changed = collected.summary.files > 0

      if (run.isolation === 'worktree' && changed) {
        if (cleanupReview) {
          if (!collected.patchPath) throw new Error('未能保存改动补丁，已保留工作区')
          run.review = 'archived'
          run.resultPath = collected.patchPath ?? run.workspace.worktreePath
          await cleanupWorkspace(run.workspace)
          run.worktreeDone = true
        } else {
          run.review = 'pending'
          run.resultPath = run.workspace.worktreePath
        }
      } else {
        run.review = 'none'
        run.resultPath = collected.patchPath
        await cleanupWorkspace(run.workspace)
        run.worktreeDone = true
      }

      await this.writeMetadata(run, collected.patchPath)
    } catch (error) {
      run.review = run.isolation === 'worktree' ? 'conflict' : 'none'
      run.error = run.error ?? `读取子代理差异失败：${error instanceof Error ? error.message : String(error)}`
      run.resultPath = run.workspace.worktreePath
      await this.writeMetadata(run)
    }
    run.reviewDecided = true
    this.emit(run)
    if (!run.notified) {
      run.notified = true
      try {
        this.opts.onFinished?.(this.snapshot(run))
      } catch {
      }
    }
  }

  private async archiveOnExit(run: Run): Promise<void> {
    if (run.worktreeDone) return

    if (run.isolation === 'worktree' && (run.review === 'pending' || run.review === 'conflict')) {
      try {
        const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
        const collected = await collectDiff(run.workspace, archiveDir, run.id)
        if (collected.summary.files > 0 && !collected.patchPath) throw new Error('未能保存改动补丁')
        run.diff = collected.summary
        run.review = 'archived'
        run.resultPath = collected.patchPath ?? run.workspace.worktreePath
        await this.writeMetadata(run, collected.patchPath)
      } catch (error) {
        run.error = run.error ?? `退出归档失败，已保留工作区：${error instanceof Error ? error.message : String(error)}`
        this.emit(run)
        return
      }
    }

    await cleanupWorkspace(run.workspace)
    run.worktreeDone = true
    this.emit(run)
  }

  private async writeMetadata(run: Run, patchPath?: string): Promise<void> {
    try {
      await this.history.save(this.snapshot(run), run.workspace.rootCwd, {
        limits: { totalMs: run.totalMs, stallTimeoutMs: run.idleMs, graceMs: run.graceMs },
        patchPath: patchPath ?? run.diff?.patchPath
      })
    } catch (error) {
      console.warn('[subagent] 保存历史失败', error)
    }
  }

  private async awaitSettled(run: Run): Promise<void> {
    if (run.settling) { try { await run.settling } catch { } }
    if (run.finalizing) { try { await run.finalizing } catch { } }
  }

  async merge(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'merged')
    await this.awaitSettled(run)
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，结束后才能合并' }
    if (run.review === 'merged') return { ok: true }
    if (run.review !== 'pending' && run.review !== 'conflict') {
      return { ok: false, error: '该任务没有待合并的改动' }
    }
    const patchPath = run.diff?.patchPath
    if (!patchPath || !run.diff?.files) {
      return { ok: false, error: '没有可合并的补丁，已保留工作区供检查' }
    }

    try {
      const res = await applyPatch(run.workspace.rootCwd, patchPath)
      if (!res.ok) {
        run.review = 'conflict'
        run.error = res.error
        await this.writeMetadata(run, patchPath)
        this.emit(run)
        return res
      }

      run.review = 'merged'
      run.resultPath = patchPath
      run.error = undefined
      await cleanupWorkspace(run.workspace)
      run.worktreeDone = true
      await this.writeMetadata(run, patchPath)
      this.emit(run)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `合并失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async discard(id: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'discarded')
    await this.awaitSettled(run)
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: '子代理仍在运行，先停止它' }
    try {
      run.review = 'discarded'
      run.resultPath = run.diff?.patchPath
      await cleanupWorkspace(run.workspace)
      run.worktreeDone = true
      await this.writeMetadata(run, run.diff?.patchPath)
      this.emit(run)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `放弃改动失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async reviewHistory(id: string, review: 'merged' | 'discarded'): Promise<{ ok: boolean; error?: string }> {
    const record = this.history.get(id)
    if (!record) return { ok: false, error: '找不到这个子代理' }
    const run = { ...record.run }
    if (run.review === review) return { ok: true }
    if (review === 'merged') {
      if (!['pending', 'conflict', 'archived'].includes(run.review ?? '') || !run.diff?.files || !run.diff.patchPath) {
        return { ok: false, error: '历史任务没有可合并的补丁' }
      }
      const result = await applyPatch(record.rootCwd, run.diff.patchPath)
      if (!result.ok) return result
    }
    run.review = review
    await this.history.save(run, record.rootCwd)
    this.opts.onChange(run)
    return { ok: true }
  }

  private stallLimit(run: Run): number {
    return run.runningTools.size ? run.idleMs * TOOL_RUNNING_STALL_FACTOR : run.idleMs
  }

  private armWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    clearTimeout(run.timer)
    const at = Math.min(run.totalMs ? run.activeSince + run.totalMs : Infinity, run.lastProgressAt + this.stallLimit(run))
    run.timer = setTimeout(() => this.onWatch(run), Math.max(10, at - Date.now()))
  }

  private onWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    const now = Date.now()
    if (run.totalMs && now >= run.activeSince + run.totalMs) void this.wrapUp(run, totalTimeoutText(run.totalMs))
    else if (now >= run.lastProgressAt + this.stallLimit(run)) void this.wrapUp(run, stallTimeoutText(this.stallLimit(run)))
    else this.armWatch(run)
  }

  private async wrapUp(run: Run, text: string): Promise<void> {
    if (run.wrapUp || run.settled) return
    if (run.status !== 'running') {
      await this.fail(run.id, text, 'timeout')
      return
    }
    run.wrapUp = { reason: 'timeout', since: Date.now() }
    run.progressWarning = text
    run.latestActivity = `${text}，正在收尾…`
    this.emit(run)
    clearTimeout(run.timer)
    run.timer = setTimeout(() => void this.fail(run.id, text, 'timeout'), run.graceMs)
    try {
      const res = await run.rpc.command('steer', { message: wrapUpMessage(text) }, { timeoutMs: 5000 })
      if (!res.success) await this.fail(run.id, text, 'timeout')
    } catch {
      await this.fail(run.id, text, 'timeout')
    }
  }

  private async waitReady(
    rpc: SubagentRpc,
    timeoutMs: number
  ): Promise<{ ok: boolean; model?: string; thinkingLevel?: string }> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (!rpc.running) return { ok: false }
      try {
        const res = await rpc.command('get_state', undefined, { timeoutMs: 2000 })
        if (res.success) {
          const data = res.data as { model?: unknown; thinkingLevel?: unknown } | undefined
          return {
            ok: true,
            model: modelLabel(data?.model),
            thinkingLevel: typeof data?.thinkingLevel === 'string' && data.thinkingLevel ? data.thinkingLevel : undefined
          }
        }
      } catch {
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false }
  }

  private refreshContext(run: Run): void {
    const revision = (run.contextRevision ?? 0) + 1
    run.contextRevision = revision
    run.contextRefresh = (async () => {
      try {
        const result = await run.rpc.command('get_session_stats', undefined, { timeoutMs: 2000 })
        if (!result.success || run.contextRevision !== revision) return
        const data = result.data as { contextUsage?: unknown } | undefined
        const usage = normalizeSubagentContextUsage(data?.contextUsage)
        if (!usage) return
        run.contextUsage = usage
        this.emit(run)
      } catch {
      }
    })()
  }

  private closedForEvents(run: Run): boolean {
    return run.settled || run.status === 'cancelled' || run.status === 'error'
  }

  private handleEvent(run: Run, evt: Record<string, unknown>): void {
    if (this.opts.onEvent) {
      try {
        this.opts.onEvent(run.id, evt, run)
      } catch {
      }
    }
    const type = String(evt.type ?? '')
    if (PROGRESS_EVENTS.has(type)) {
      run.lastProgressAt = Date.now()
    }
    if (process.env.YAN_DEBUG_SUBAGENT) {
      try {
        appendFileSync(
          join(tmpdir(), 'yan-subagent-events.log'),
          `${run.id} ${type} ${JSON.stringify(evt).slice(0, 600)}\n`,
          'utf8'
        )
      } catch {
      }
    }
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
      const raw = evt.message as PiMessage | undefined
      if (!raw) return

      if (raw.role === 'assistant' && raw.stopReason) {
        run.stopReason = raw.stopReason
        if (raw.stopReason === 'error') {
          run.error = modelErrorNotice(raw.errorMessage)
          run.lastModelErrorText = modelErrorText(raw.errorMessage)
        }
      }

      if (raw.role === 'toolResult') {
        const result = normalizeMessage(raw, run.msgSeq)?.toolCalls?.[0]
        const target = result
          ? run.transcript.find((m: UIMessage) => m.toolCalls?.some((c) => c.id === result.id))
          : undefined
        const call = target?.toolCalls?.find((c) => c.id === result?.id)
        if (result && call) {
          call.status = result.status
          call.output = result.output
          call.details = result.details
          if (result.cancelled) call.cancelled = true
          run.latestActivity = `${call.name}${result.status === 'error' ? ' 失败' : ' 完成'}`
          this.emit(run)
          return
        }
      }

      if (type === 'message_start' || run.streamingId === undefined) {
        run.msgSeq += 1
        run.streamingId = `m${run.msgSeq}`
      }
      const msg = normalizeMessage(raw, run.msgSeq)
      if (!msg) return

      const idx = run.transcript.findIndex((m: UIMessage) => m.id === msg.id)
      if (idx >= 0) run.transcript[idx] = msg
      else run.transcript.push(msg)
      const usage = toUsage(raw.usage)
      if (usage) {
        run.usageSnapshots = ingestUsageSnapshot(run.usageSnapshots, msg.id, usage)
        run.usage = addUsage(run.baseUsage, accumulateUsage(run.usageSnapshots))
      }
      if (type === 'message_end') {
        run.streamingId = undefined
        if (raw.role === 'assistant') this.refreshContext(run)
      }
      if (run.transcript.length > MAX_TRANSCRIPT) {
        run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT)
      }
      run.latestActivity = activityOf(msg)
      if (type === 'message_update' && raw.role === 'assistant') this.emitStream(run)
      else this.emit(run)
      return
    }

    if (type === 'tool_execution_end' && typeof evt.toolCallId === 'string') run.runningTools.delete(evt.toolCallId)
    if (type === 'tool_execution_start') {
      if (typeof evt.toolCallId === 'string') run.runningTools.add(evt.toolCallId)
      run.toolCalls = (run.toolCalls ?? 0) + 1
      if (!run.wrapUp) run.latestActivity = `运行 ${String(evt.toolName ?? '工具')}`
      this.emit(run)
      return
    }

    if (type === 'agent_end') {
      if (this.closedForEvents(run)) return
      if (evt.willRetry === true) {
        run.latestActivity = '模型请求失败，等待自动重试…'
        this.emit(run)
      }
      return
    }

    if (type === 'auto_retry_start') {
      if (this.closedForEvents(run)) return
      const attempt = finiteCount(evt.attempt)
      const maxAttempts = finiteCount(evt.maxAttempts)
      run.retryAttempt = attempt
      run.retryMaxAttempts = maxAttempts
      run.recovery = { ...run.recovery, piRetries: attempt, piMaxRetries: maxAttempts }
      run.latestActivity = retryActivity(attempt, maxAttempts)
      this.emit(run)
      return
    }

    if (type === 'auto_retry_end') {
      if (this.closedForEvents(run)) return
      if (evt.success === false) {
        run.stopReason = 'error'
        run.error = run.error ?? modelErrorNotice(evt.finalError ?? evt.error)
        run.latestActivity = run.retryAttempt !== undefined
          ? `自动重试失败（已观察到第 ${run.retryAttempt} 次）`
          : '自动重试失败'
      } else if (evt.success === true) {
        run.error = undefined
        run.stopReason = undefined
        run.lastModelErrorText = undefined
        run.retryAttempt = undefined
        run.recovery = run.recovery?.resumed ? { resumed: true } : undefined
        run.latestActivity = '自动重试成功，继续'
      } else {
        run.latestActivity = '自动重试结束（结果未知）'
      }
      this.emit(run)
      return
    }

    if (type === 'agent_settled') {
      if (this.closedForEvents(run)) return
      if (this.canResumeAfterModelError(run)) {
        void this.resumeAfterModelError(run)
        return
      }
      this.settle(run)
    }
  }

  private canResumeAfterModelError(run: Run): boolean {
    return run.status === 'running' && run.stopReason === 'error' && !run.wrapUp && !run.recovery?.resumed &&
      run.retryAttempt === undefined && isTransientModelError(run.lastModelErrorText)
  }

  private async resumeAfterModelError(run: Run): Promise<void> {
    run.recovery = { ...run.recovery, resumed: true }
    run.stopReason = undefined
    run.error = undefined
    run.latestActivity = '模型请求中断且未自动重试，正在同一会话自动续跑（1/1）…'
    run.lastProgressAt = Date.now()
    this.armWatch(run)
    this.emit(run)
    const failed = (): void => {
      if (run.settled || run.status !== 'running') return
      run.stopReason = 'error'
      run.error = modelErrorNotice(run.lastModelErrorText)
      this.settle(run)
    }
    try {
      const res = await run.rpc.command('prompt', { message: MODEL_ERROR_RESUME_PROMPT }, { timeoutMs: 10_000 })
      if (!res.success) failed()
    } catch {
      failed()
    }
  }

  private settle(run: Run): void {
    run.settled = true
    clearTimeout(run.timer)
    const modelFailed = run.status !== 'cancelled' && run.stopReason === 'error'
    const wrapped = run.status !== 'cancelled' && !modelFailed ? run.wrapUp : undefined
    run.status = run.status === 'cancelled' ? 'cancelled' : modelFailed ? 'error' : 'done'
    run.endReason = run.status === 'cancelled' ? 'stopped' : modelFailed ? 'model-error' : (wrapped?.reason ?? 'completed')
    run.wrapUp = undefined
    run.progressWarning = undefined
    run.endedAt = Date.now()
    if (modelFailed) run.error = run.error ?? modelErrorNotice(undefined)
    run.latestActivity = modelFailed
      ? modelFailureActivity(run.recovery)
      : wrapped ? '超时，已收尾' : '已完成'
    this.emit(run)
    run.settling = (async () => {
      await this.waitTranscriptQuiet(run)
      await run.contextRefresh
      try {
        await run.rpc.close()
      } catch {
      }
      await this.finalize(run, false)
    })().catch((error) => console.warn('[subagent] 收尾失败', error))
  }

  private async waitTranscriptQuiet(run: Run, quietMs = 600, maxMs = 5000): Promise<void> {
    const snapshot = (): string =>
      JSON.stringify(
        run.transcript.map((m) => [
          m.id,
          m.text.length,
          m.toolCalls?.map((c) => [c.name, c.status, c.output?.length ?? 0]) ?? []
        ])
      )
    let last = snapshot()
    let changedAt = Date.now()
    const started = Date.now()
    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 150))
      const now = snapshot()
      if (now !== last) {
        last = now
        changedAt = Date.now()
        continue
      }
      if (Date.now() - changedAt >= quietMs) return
    }
  }
}

function modelLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { provider, id } = raw as { provider?: unknown; id?: unknown }
  if (typeof id !== 'string' || !id) return undefined
  return typeof provider === 'string' && provider ? `${provider}/${id}` : id
}

function modelMismatch(requested: string, actual: string): boolean {
  const want = requested.replace(/:(off|minimal|low|medium|high|xhigh)$/i, '').trim()
  if (!want.includes('/') || want.includes('*')) return false
  return want.toLowerCase() !== actual.toLowerCase()
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function forwardedMessage(text: string, mode: SubagentSendMode | 'resume', from: SubagentSendFrom): string {
  const label = from === 'user' ? '【用户追加】' : '【主会话追加】'
  const timing = mode === 'resume'
    ? '你已经完成过原任务，这是新的消息；在之前的工作基础上继续'
    : mode === 'steer' ? '请在继续之前先考虑这条信息' : '这是在你完成原任务后补充的要求'
  return `${label}${timing}；仍在原任务范围内工作，结束时简短汇报。\n\n${text}`
}

function addUsage(base: SubagentUsageTotals | undefined, next: SubagentUsageTotals): SubagentUsageTotals {
  if (!base || base.reportedMessages <= 0) return next
  const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))
  return {
    input: sum(base.input, next.input),
    output: sum(base.output, next.output),
    cacheRead: sum(base.cacheRead, next.cacheRead),
    cacheWrite: sum(base.cacheWrite, next.cacheWrite),
    totalTokens: sum(base.totalTokens, next.totalTokens),
    cost: sum(base.cost, next.cost),
    reportedMessages: base.reportedMessages + next.reportedMessages
  }
}

function resumeBrief(run: SubagentRun): SubagentBrief {
  if (run.brief) return run.brief
  const parsed = parseSubagentBrief(undefined, run.task)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.brief
}

function lastMessageSeq(transcript: readonly UIMessage[]): number {
  let max = transcript.length
  for (const message of transcript) {
    const match = /^m(\d+)$/.exec(message.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

async function latestSessionFile(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  let best: { path: string; mtime: number } | undefined
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(dir, entry.name)
    const mtime = (await stat(path).catch(() => undefined))?.mtimeMs
    if (mtime !== undefined && (!best || mtime > best.mtime)) best = { path, mtime }
  }
  return best?.path
}

const MODEL_ERROR_RESUME_PROMPT = '[模型错误恢复 · 自动继续 1/1]\n上一轮模型请求因暂时性错误（超时、连接中断或服务过载）中断，且没有自动重试。请核对已完成的工具结果，继续尚未完成的原任务；不要重复已完成的操作。若原任务已完成或无法安全继续，请简短说明并结束。'

function modelFailureActivity(recovery: SubagentRecovery | undefined): string {
  if (recovery?.resumed) return '自动续跑 1 次后仍失败'
  if (recovery?.piRetries) return `自动重试 ${recovery.piRetries} 次后仍失败`
  return '模型返回错误（未自动重试）'
}

function retryActivity(attempt: number | undefined, maxAttempts: number | undefined): string {
  if (attempt === undefined) return '模型请求失败，正在自动重试…'
  return maxAttempts === undefined || maxAttempts < attempt
    ? `模型请求失败，正在自动重试（第 ${attempt} 次）`
    : `模型请求失败，正在自动重试（第 ${attempt}/${maxAttempts} 次）`
}

function activityOf(msg: UIMessage): string {
  if (msg.role === 'assistant') {
    const first = msg.text.split('\n').map((x) => x.trim()).find(Boolean)
    if (first) return first.slice(0, 80)
    if (msg.toolCalls?.length) return `调用 ${msg.toolCalls[msg.toolCalls.length - 1].name}`
    if (msg.thinking) return '推理中…'
    return '生成中…'
  }
  return msg.text.split('\n').find(Boolean)?.slice(0, 80) ?? '处理中…'
}
