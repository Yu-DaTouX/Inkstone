import { pick } from '../shared/ui-lang'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { SubagentHistory, type SubagentHistoryRecord } from './subagent-history'
import { launchDigest, persistableForkLaunch, resolveResumeLaunch, restoreForkSource, subagentResumability, type ResumeLaunch, type ResumeMeta } from './subagent-resume'
import { pruneSubagentArchive } from './subagent-prune'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { reserveWorkspaceMutation, workspaceMutationInProgress } from './workspace-mutation'
import type { QuotaWindow, SubagentEndReason, SubagentRecovery, SubagentRun, SubagentStopResult, UIMessage } from '../shared/ipc'
import { decideQuotaResume, isQuotaWaitError, QUOTA_RESUME_POLL_MS } from '../shared/quota-resume'
import { continuationPrompt, SUBAGENT_QUOTA_RESUME_PROMPT } from '../shared/continuation-prompt'
import { normalizeMessage, toUsage, type PiMessage } from './normalize'
import { SessionItemProjector } from './session-items/projector'
import { accumulateUsage, ingestUsageSnapshot, normalizeSubagentContextUsage, type SubagentUsageTotals, type UsageSnapshots } from '../shared/subagent-usage'
import {
  briefPrompt,
  parseSubagentBrief,
  summarizeSubagentRun,
  type SubagentBrief
} from '../shared/subagent-brief'
import { PiRpc, resolvePi } from './protocol'
import { CapabilityServer, type CapabilityCommandResult } from './capability-server'
import { BackgroundBashCommands } from './background-bash'
import { nativePiToolsSupported } from '../shared/agent-context'
import { isTransientModelError, modelErrorNotice, modelErrorText } from '../shared/model-errors'
import { redactDiagnosticText } from '../shared/redact-diagnostic'
import { subagentModelError, subagentPiArgs } from '../shared/subagent-pi-launch'
import { THINKING_LEVELS } from '../shared/thinking-levels'
import { confirmRegisteredModel } from './subagents/registered-model'
import { forkPiArgs, forkPrompt, sideQuestionPrompt, writeForkSession, type SubagentForkSource } from './subagent-fork'
import { runArtifactPreview, type PreviewHtml } from './artifact-preview-command'
import { dangerReviewOf } from './agent-commands/danger-confirm'
import type { ModelReviewReceiptInput } from './approval-log'
import {
  applyPatch,
  cleanupWorkspace as removeWorkspace,
  collectDiff,
  prepareWorkspace,
  preserveIgnoredOutputs,
  recoverWorktree,
  savedOutputsDir,
  type PreparedWorkspace,
  type PreservedOutputs
} from './subagent-isolation'

export type SubagentReviewResult = { ok: boolean; error?: string; outputs?: PreservedOutputs }

const MAX_CONCURRENT = 24
const STALL_TIMEOUT_MS = 10 * 60 * 1000
const BACKGROUND_NOTICE_GRACE_MS = 15_000
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
  if (ms >= 60_000) return pick(`${Math.round(ms / 60_000)} 分钟`, `${Math.round(ms / 60_000)} min`)
  if (ms >= 1_000) return pick(`${Math.round(ms / 1000)} 秒`, `${Math.round(ms / 1000)} s`)
  return pick(`${ms} 毫秒`, `${ms} ms`)
}
const overtimeText = (ms: number): string => pick(`已超过设定的 ${spanText(ms)}，已告知主会话，继续运行`, `Past the ${spanText(ms)} limit; the main agent was told and it keeps running`)
const stallTimeoutText = (ms: number): string => pick(`停滞超时（超过 ${spanText(ms)} 未收到模型输出或工具事件）`, `Stalled (no model output or tool events for over ${spanText(ms)})`)

function wrapUpMessage(text: string): string {
  return `【宿主提示】${text}。不要再调用任何工具，立刻用已有的资料交出结论：先说已确认的结论，再说明哪些部分没来得及核实。`
}
const MAX_TRANSCRIPT = 200
const MAX_FINISHED_IN_MEMORY = 200
const ABORT_TIMEOUT_MS = 5_000

async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<{ ok: boolean; errors: string[] }> {
  const result = await removeWorkspace(workspace)
  for (const error of result.errors) console.warn(`[subagent] ${error}`)
  return result
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
    facts.push(pick(`无法启动 pi：${redactLocalDiagnostic(info.spawnError, 300) ?? info.spawnError}`, `Could not start pi: ${redactLocalDiagnostic(info.spawnError, 300) ?? info.spawnError}`))
  } else {
    const bits: string[] = []
    if (info.code !== undefined) bits.push(`code=${info.code ?? 'null'}`)
    if (info.signal !== undefined) bits.push(`signal=${info.signal ?? 'null'}`)
    if (bits.length) facts.push(pick(`pi 子进程提前退出（${bits.join('，')}）`, `pi subprocess exited early (${bits.join(', ')})`))
  }
  const tail = stderrTail.length ? pick(`；stderr：${stderrTail.join(' | ')}`, `; stderr: ${stderrTail.join(' | ')}`) : ''
  return `${facts.join('；') || pick('pi 子进程提前退出', 'pi subprocess exited early')}${tail}`
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
  hasBackgroundWork?(): boolean
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
  quotaBounces?: number
  overtimeNoticed?: boolean
  workspace: PreparedWorkspace
  finalizing?: Promise<void>
  settling?: Promise<void>
  worktreeDone?: boolean
  notified?: boolean
  reviewDecided?: boolean
  msgSeq: number
  streamingId?: string
  streamProjector?: SessionItemProjector
  resultKey?: string
  stopReason?: string
  usageSnapshots: UsageSnapshots
  queued?: QueuedMessage[]
  contextRevision?: number
  contextRefresh?: Promise<void>
  brief: SubagentBrief
  stderrTail: string[]
  forkSource?: SubagentForkSource
  launch?: ResumeLaunch
  exitInfo?: { code: number | null; signal: string | null; spawnError?: string }
  awaitingBackground?: boolean
}

export interface SubagentApprovalOrigin { sessionId?: string; runId?: string; subagentId?: string }
const READ_ONLY_HOST_COMMANDS = ['search.query', 'search.fetch', 'search.docs']

export interface SubagentDangerAnswer { decision: 'allow' | 'deny' | 'no-answer' | 'timeout'; feedback?: string }

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
  parentSessionFile?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  projectId?: string
  thinkingLevel?: string
  modelPinned?: boolean
}

export type SubagentSendMode = 'steer' | 'followUp'
export type SubagentSendFrom = 'parent' | 'user'
interface QueuedMessage { text: string; mode: SubagentSendMode; from: SubagentSendFrom }
export interface SubagentSendResult { ok: boolean; error?: string; run?: SubagentRun; delivery?: 'queued' | 'started' | 'resumed' }

export interface SubagentOptions {
  cwd: string
  piBin?: string
  thinkingLevel?: string
  modelPinned?: boolean
  parentSessionId?: string
  parentSessionFile?: string
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
  dangerPrefs?(): Promise<{ mode: 'danger' | 'all'; outsideWrites: boolean; allowRoots: string[] }>
  recordDangerReview?(review: ModelReviewReceiptInput, origin?: SubagentApprovalOrigin): void
  resolveModelApi?(label: string, origin: { sessionId?: string; runId?: string }): Promise<string | undefined>
  pruneHistory?(): boolean | Promise<boolean>
  extensions?: string[]
  readOnlyExtension?: string
  runReadOnlyCommand?(command: string, params: Record<string, unknown>, cwd: string, signal?: AbortSignal, ownerId?: string): Promise<CapabilityCommandResult>
  appendSystemPrompt?: string
  quotaWatch?: SubagentQuotaWatch
  onChange: (run: SubagentRun) => void
  onPatch?: (payload: { id: string; run: SubagentRun; transcriptFrom: number }) => void
  onRemove?: (id: string) => void
  onFinished?: (run: SubagentRun) => void
  onOvertime?: (run: SubagentRun, minutes: number) => void
  onEvent?: (runId: string, evt: Record<string, unknown>, run: SubagentRun) => void
  createRpc?: (opts: { cwd: string; piBin?: string; args: string[] }) => SubagentRpc
  prepare?: (rootCwd: string, id: string, isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd') => Promise<PreparedWorkspace>
}

export interface SubagentQuotaWatch {
  switchAccount?(run: SubagentRun): Promise<string | null>
  check(model: string): Promise<{ windows: QuotaWindow[]; accounts: number } | null>
  waiting(run: SubagentRun): void
}

const QUOTA_BOUNCE_LIMIT = 3
export const QUOTA_SWITCH_AFTER_MS = 15 * 60_000
export const QUOTA_GIVE_UP_AFTER_MS = 30 * 60_000
const ignoredOnlyNote = () => pick('子 Agent只写了被 .gitignore 忽略的文件', 'Subagent only wrote files ignored by .gitignore')
const skippedOutputsNote = (skipped: readonly string[]) => {
  const list = `${skipped.slice(0, 5).join(pick('、', ', '))}${skipped.length > 5 ? pick(' 等', ' and more') : ''}`
  return pick(`被忽略的产物超出 200MB 另存上限，这些路径下有文件没有另存（说明文件与图片优先保留），已随工作区清理：${list}`, `Ignored outputs exceeded the 200MB save limit; some files under these paths were not saved (notes and images are kept first) and were removed with the workspace: ${list}`)
}

export interface SubagentHostCommands {
  onlyCommands: string[]
  handle(command: string, params: Record<string, unknown>, cwd: string, signal?: AbortSignal, ownerId?: string): Promise<CapabilityCommandResult | undefined>
}

export function subagentHostCommands(opts: {
  readOnlyHost?: SubagentOptions['runReadOnlyCommand']
  previewHtml?: PreviewHtml
}): SubagentHostCommands {
  const onlyCommands = ['danger.confirm', 'danger.prefs', 'danger.review', ...(opts.readOnlyHost ? READ_ONLY_HOST_COMMANDS : []), ...(opts.previewHtml ? ['artifact.preview'] : [])]
  return {
    onlyCommands,
    handle: async (command, params, cwd, signal, ownerId) => {
      if (opts.readOnlyHost && READ_ONLY_HOST_COMMANDS.includes(command)) return opts.readOnlyHost(command, params, cwd, signal, ownerId)
      if (command === 'artifact.preview') return runArtifactPreview(opts.previewHtml, params.path, cwd, params.at)
      return undefined
    }
  }
}

function mergeCleanupPending(run: Run): string {
  const detail = run.error ?? run.workspace.worktreePath ?? ''
  return pick(`补丁已合并，但工作树没能清理，可再次 merge 只重试清理（不会重复应用补丁）：${detail}`, `The patch is merged, but the worktree could not be cleaned up; merge again retries the cleanup only (the patch is not applied twice): ${detail}`)
}

function workspaceBusy(): { ok: false; error: string } {
  return { ok: false, error: pick('这个文件夹正在回退代码，稍后再合并', 'This folder is restoring a checkpoint; merge again shortly') }
}

async function applyPatchExclusive(cwd: string, patchPath: string): ReturnType<typeof applyPatch> {
  const release = reserveWorkspaceMutation(cwd)
  if (!release) return workspaceBusy()
  try {
    return await applyPatch(cwd, patchPath)
  } finally {
    release()
  }
}

export class SubagentController {
  private runs = new Map<string, Run>()
  private pushedTranscript = new Map<string, { length: number; firstId: string; lastId: string }>()
  private preparing = 0
  private launchGeneration = 0
  private pendingLaunches = new Set<Promise<void>>()
  private resuming = new Map<string, { cancelled: boolean }>()
  private reviewing = new Set<string>()
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
    await this.recoverInterruptedWorktrees()
    void this.pruneArchive()
  }

  private async recoverInterruptedWorktrees(): Promise<void> {
    const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
    for (const record of this.history.list()) {
      const { run } = record
      if (run.isolation !== 'worktree' || run.status !== 'error' || run.endReason !== 'exited' || (run.review ?? 'none') !== 'none' || run.diff?.patchPath || this.runs.has(run.id)) continue
      try {
        const workspace = record.resume?.workspace ?? await recoverWorktree(run.cwd, record.rootCwd)
        if (!workspace?.worktreePath || !existsSync(workspace.worktreePath)) continue
        const collected = await collectDiff(workspace, archiveDir, run.id)
        const keepWorkspace = collected.summary.files > 0 || (collected.ignoredOutputs?.length ?? 0) > 0
        const saved = keepWorkspace ? { ok: true as const, path: undefined } : await preserveIgnoredOutputs(workspace, archiveDir, run.id)
        const kept = keepWorkspace ? '' : !saved.ok ? pick('被忽略的产物没能另存，已保留工作区', 'Ignored outputs could not be saved; workspace kept') : ''
        const cleaned = keepWorkspace || kept ? { ok: false, errors: [] as string[] } : await removeWorkspace(workspace)
        const note = keepWorkspace ? pick('应用退出时子 Agent未完成；工作树已保留，可以继续派信息让它原地续接，也可以合并或放弃它的改动', 'Subagent unfinished at app exit; worktree kept. Send a message to resume it, or merge or discard its changes') : kept ? pick(`应用退出时子 Agent未完成；${kept}：${workspace.worktreePath}`, `Subagent unfinished at app exit; ${kept}: ${workspace.worktreePath}`) : pick('应用退出时子 Agent未完成，未自动恢复执行', 'Subagent unfinished at app exit; not resumed')
        const next: SubagentRun = {
          ...run,
          review: keepWorkspace ? 'pending' : 'none',
          diff: collected.summary,
          resultPath: keepWorkspace ? workspace.worktreePath : collected.patchPath ?? (saved.ok && saved.path ? saved.path : workspace.worktreePath),
          ...(saved.ok && saved.path ? { savedOutputsPath: saved.path } : {}),
          ...(keepWorkspace && collected.ignoredOutputs?.length ? { pendingOutputs: { path: savedOutputsDir(archiveDir, run.id), files: collected.ignoredOutputs } } : {}),
          error: [note, ...cleaned.errors].join(String.fromCharCode(10))
        }
        await this.history.save(next, record.rootCwd, { patchPath: collected.patchPath, ...(keepWorkspace ? { resume: { ...record.resume, workspace } } : {}) })
      } catch (error) {
        console.warn('[subagent] 恢复中断的 worktree 子代理失败', run.id, error)
      }
    }
  }

  private async pruneArchive(): Promise<void> {
    try {
      if (this.opts.pruneHistory && !(await this.opts.pruneHistory())) return
      const dir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
      const removed = await pruneSubagentArchive(dir, { liveIds: new Set(this.runs.keys()) })
      if (removed.length) this.history.forget(removed)
    } catch (error) {
      console.warn('[subagent] 清理旧子代理记录失败', error)
    }
  }

  setContext(context: SubagentContext): void {
    const { cwd, parentSessionId, parentSessionFile, parentRunId, parentGeneration, parentMessageId, projectId } = context
    this.opts = { ...this.opts, cwd, parentSessionId, parentSessionFile, parentRunId, parentGeneration, parentMessageId, projectId }
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
      ...(run.followUp ? { followUp: run.followUp } : {}),
      ...(run.quotaWait ? { quotaWait: run.quotaWait } : {}),
      cwd: run.cwd,
      parentSessionId: run.parentSessionId,
      parentRunId: run.parentRunId,
      parentGeneration: run.parentGeneration,
      parentMessageId: run.parentMessageId,
      ...(run.parentMessageIds?.length ? { parentMessageIds: run.parentMessageIds } : {}),
      projectId: run.projectId,
      isolation: run.isolation,
      ...(run.fork ? { fork: true } : {}),
      ...(run.forkSource?.sideQuestion ? { sideQuestion: true } : {}),
      resultPath: run.resultPath,
      ...(run.savedOutputsPath ? { savedOutputsPath: run.savedOutputsPath } : {}),
      ...(run.pendingOutputs ? { pendingOutputs: run.pendingOutputs } : {}),
      model: run.model,
      ...(run.modelPinned ? { modelPinned: true } : {}),
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
      result: this.resultFor(run),
      resumable: subagentResumability({
        status: run.status, isolation: run.isolation, review: run.review, fork: run.fork, launchFailed: run.launchFailed,
        live: true, worktreeAlive: worktreeAlive(run), forkLaunchSaved: !!run.forkSource
      })
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

  private resultFor(run: Run): NonNullable<SubagentRun['result']> {
    const result = this.resultOf(run)
    return run.status === 'running' || run.status === 'starting' ? { ...result, fullText: '' } : result
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

  hasActiveWriter(cwd: string): boolean {
    const root = resolve(cwd)
    for (const run of this.runs.values()) {
      if (run.isolation === 'shared-cwd' && (run.status === 'starting' || run.status === 'running') && resolve(run.workspace?.rootCwd ?? run.cwd) === root) return true
    }
    return false
  }

  list(): SubagentRun[] {
    const historical = this.history.list().filter(({ run }) => !this.runs.has(run.id)).map((record) => this.historic(record))
    return [...historical, ...[...this.runs.values()].map((r) => this.snapshot(r))].sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): SubagentRun | undefined {
    const run = this.runs.get(id)
    if (run) return this.snapshot(run)
    const record = this.history.get(id)
    return record ? this.historic(record) : undefined
  }

  async getFull(id: string): Promise<SubagentRun | undefined> {
    const run = this.runs.get(id)
    if (run) return this.snapshot(run)
    const record = await this.history.full(id)
    return record ? this.historic(record) : undefined
  }

  private historic(record: SubagentHistoryRecord): SubagentRun {
    const { run } = record
    return {
      ...run,
      resumable: subagentResumability({
        status: run.status, isolation: run.isolation, review: run.review, fork: run.fork, launchFailed: run.launchFailed,
        live: false, worktreeAlive: (run.review === 'pending' || run.review === 'conflict') && !!keptWorktreeOf(record), forkLaunchSaved: !!record.resume?.forkLaunch
      })
    }
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

  async clearFinished(ids?: readonly string[]): Promise<void> {
    const only = ids ? new Set(ids) : null
    for (const run of [...this.runs.values()]) {
      if (only && !only.has(run.id)) continue
      if (run.status === 'running' || run.status === 'starting') continue
      if (run.settling) { try { await run.settling } catch { } }
      if (run.finalizing) { try { await run.finalizing } catch { } }
    }
    for (const run of this.list()) {
      if (only && !only.has(run.id)) continue
      if (run.status === 'running' || run.status === 'starting' || this.resuming.has(run.id)) continue
      if (run.review === 'pending' || run.review === 'conflict') continue
      const live = this.runs.get(run.id)
      if (live && (!live.reviewDecided || !live.worktreeDone)) continue
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
      if (!snapshot) return { ok: false, error: pick('找不到这个子 Agent', 'Subagent not found') }
      if (snapshot.status !== 'error') return { ok: false, error: pick('只能对已失败的子 Agent选择不再处理', 'Only failed subagents can be dismissed') }
      if (snapshot.review === 'pending' || snapshot.review === 'conflict' || (run && !run.reviewDecided)) {
        return { ok: false, error: pick('请先审阅并合并或明确放弃该子 Agent的改动', 'Review and merge or discard this subagent\'s changes first') }
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
      return { ok: false, error: pick(`未能保存处理标记：${error instanceof Error ? error.message : String(error)}`, `Could not save the dismissal: ${error instanceof Error ? error.message : String(error)}`) }
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
    if (fork && isolation !== 'shared-cwd') return { ok: false, error: pick('fork 子 Agent只能在当前目录运行', 'Fork subagents can only run in the current folder') }
    if (this.stoppingAll) return { ok: false, error: pick('子 Agent正在停止清理，请稍后重试', 'Subagents are being stopped; try again shortly') }
    const text = task.trim()
    if (!text) return { ok: false, error: pick('任务描述为空', 'Task is empty') }
    const modelError = subagentModelError(model ?? process.env.YAN_TEST_MODEL, isolation === 'controlled-cwd')
    if (modelError) return { ok: false, error: modelError }
    if (this.runningCount >= MAX_CONCURRENT) {
      return { ok: false, error: pick(`同时最多运行 ${MAX_CONCURRENT} 个子 Agent（当前 ${this.runningCount} 个），先等一个结束或停掉它`, `At most ${MAX_CONCURRENT} subagents can run at once (${this.runningCount} running); wait for one to finish or stop it`) }
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
      return { ok: false, error: pick('子 Agent在启动期间已停止', 'Subagent stopped during startup') }
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
      return { ok: false, error: pick('子 Agent在启动期间已停止', 'Subagent stopped during startup') }
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
      launch: { appendSystemPrompt: ctx.appendSystemPrompt, extensions: ctx.extensions, readOnlyExtension: ctx.readOnlyExtension },
      model,
      ...(ctx.modelPinned ? { modelPinned: true } : {}),
      status: 'starting',
      startedAt: Date.now(),
      activeSince: Date.now(),
      activation: ++this.activationSeq,
      latestActivity: pick('启动中…', 'Starting…'),
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
        await this.fail(id, pick('子 Agent启动超时', 'Subagent startup timed out'), 'startup')
        return { ok: false, error: this.runs.get(id)?.error ?? pick('子 Agent启动超时', 'Subagent startup timed out') }
      }
      if (model && ready.model && modelMismatch(model, ready.model)) {
        const message = pick(`指定的模型 ${model} 没有生效（pi 实际使用 ${ready.model}），请核对模型名与登录状态后重试，不要改用其他模型`, `Model ${model} was not applied (pi used ${ready.model}); check the model name and sign-in, then retry without switching models`)
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
      run.latestActivity = pick('已启动', 'Started')
      await this.writeMetadata(run)
      if (run.status !== 'running') return this.startupAbort(run)
      this.emit(run)

      const res = await rpc.command('prompt', { message: fork?.sideQuestion ? sideQuestionPrompt(text) : fork ? forkPrompt(briefPrompt(brief, text)) : briefPrompt(brief, text) })
      if (!res.success) {
        await this.fail(id, res.error ?? pick('启动任务失败', 'Could not start the task'))
        return { ok: false, error: res.error ?? pick('启动任务失败', 'Could not start the task') }
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
      run.exitInfo = { code: null, signal: null, spawnError: redactLocalDiagnostic(raw, 300) ?? pick('未知启动错误', 'Unknown startup error') }
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
    const args = subagentPiArgs({ sessionDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id), sessionFile, native: nativePiToolsSupported(version), readOnly: isolation === 'controlled-cwd', model: model ?? process.env.YAN_TEST_MODEL, systemPrompt: ctx.appendSystemPrompt, extensions: ctx.extensions, readOnlyExtension: ctx.readOnlyExtension, thinkingLevel: ctx.thinkingLevel })
    if (ctx.createRpc) return ctx.createRpc({ cwd, piBin: ctx.piBin, args })
    return this.spawnWithApproval(ctx, id, cwd, ctx.piBin, args, { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR, YAN_RUNNER_KIND: 'subagent', ...(ctx.parentSessionFile ? { YAN_PARENT_SESSION_FILE: ctx.parentSessionFile } : {}), ...(isolation === 'controlled-cwd' ? { YAN_READ_ONLY_SUBAGENT: '1' } : {}) }, ctx.runReadOnlyCommand)
  }

  private async createForkRpc(ctx: SubagentOptions, id: string, fork: SubagentForkSource, sessionFile?: string): Promise<SubagentRpc> {
    const sessionDir = join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'sessions', id)
    const file = sessionFile ?? (await writeForkSession(fork.sessionFile, sessionDir)).file
    const args = forkPiArgs(fork.args, { sessionDir, sessionFile: file, model: fork.model, thinkingLevel: fork.thinkingLevel })
    const piBin = fork.piBin ?? ctx.piBin
    if (ctx.createRpc) return ctx.createRpc({ cwd: fork.cwd, piBin, args })
    return this.spawnWithApproval(ctx, id, fork.cwd, piBin, args, { ...fork.env, YAN_RUNNER_ID: id, YAN_RUNNER_KIND: 'fork' }, ctx.runReadOnlyCommand)
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
    let live: PiRpc | null = null
    const background = new BackgroundBashCommands({
      ownerKeys: () => [id],
      now: () => Date.now(),
      notify: (text) => { void live?.command('prompt', { message: text, streamingBehavior: 'steer' }, { timeoutMs: 10_000 }).catch(() => undefined) },
      onIdle: () => this.backgroundIdle(id)
    })
    const approval = new CapabilityServer({
      opsDir: join(ctx.archiveDir ?? join(YAN_DIR, 'subagents'), 'approvals', id),
      onlyCommands: [...host.onlyCommands, 'shell.background'],
      handlers: {
        run: async (command, params, _context, signal) => {
          if (command === 'shell.background') return background.run(params, signal)
          const handled = await host.handle(command, params, cwd, signal, id)
          if (handled) return handled
          if (command === 'danger.prefs') return { summary: { kind: 'danger-prefs', ...(await ctx.dangerPrefs?.() ?? { mode: 'danger', outsideWrites: true, allowRoots: [] }) } }
          const origin = approvalOriginFor(this.runs.get(id), ctx, id)
          if (command === 'danger.review') {
            const review = dangerReviewOf(params)
            if (review) ctx.recordDangerReview?.({ ...review, subagentId: id }, origin)
            return { summary: { kind: 'danger-review', recorded: !!review } }
          }
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
      background.dispose()
    }
    try {
      const endpoint = await approval.start({ sessionId: id, projectId: ctx.projectId ?? id })
      const rpc = new PiRpc({
        cwd, piBin, args,
        env: { ...env,
          PATH: `${join(YAN_DIR, 'bin')}${delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
          YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token,
          YAN_SESSION_ID: id, YAN_PROJECT_ID: ctx.projectId ?? id,
          YAN_SUBAGENT_COMMANDS: host.onlyCommands.join(',') }
      })
      rpc.on('exit', () => halt())
      rpc.on('ui', (req: Record<string, unknown>) => {
        const requestId = typeof req.id === 'string' ? req.id : ''
        if (requestId && DIALOG_UI_METHODS.has(String(req.method ?? ''))) rpc.respondUi({ id: requestId, cancelled: true })
      })
      const close = rpc.close.bind(rpc)
      rpc.close = async () => { halt(); await close() }
      live = rpc
      return Object.assign(rpc, { hasBackgroundWork: () => background.busy() })
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
    if (!text) return { ok: false, error: pick('追加内容为空', 'Message is empty') }
    const from = origin.from ?? 'parent'
    const live = this.runs.get(id)
    const snapshot = live ? this.snapshot(live) : this.history.get(id)?.run
    if (!snapshot) return { ok: false, error: pick('找不到这个子 Agent', 'Subagent not found') }
    if (from === 'parent' && snapshot.parentSessionId && origin.parentSessionId !== snapshot.parentSessionId) {
      return { ok: false, error: pick('只能向本会话派出的子 Agent追加信息', 'Messages can only be sent to subagents started from this session') }
    }
    if (this.resuming.has(id) || live?.status === 'starting') return { ok: false, error: pick('子 Agent正在启动，稍后再发', 'Subagent is starting; send again shortly') }
    if (!live || live.status !== 'running' || live.settled) return this.resume(id, text, from)
    if (live.wrapUp || live.settling || live.finalizing) return { ok: false, error: pick('子 Agent正在收尾，等它结束后再发即可续接', 'Subagent is wrapping up; send again after it finishes to resume it') }
    if (live.quotaWait) {
      const queued = live.queued ?? (live.queued = [])
      queued.push({ text, mode, from })
      if (mode === 'followUp') live.followUp = text
      live.latestActivity = pick(`额度等待中：已收下这条追加信息（共 ${queued.length} 条），额度恢复后一起处理`, `Waiting for quota: message queued (${queued.length} in total); handled together once quota is restored`)
      this.emit(live)
      return { ok: true, run: this.snapshot(live), delivery: 'queued' }
    }
    const activation = live.activation
    const current = (): boolean => this.runs.get(id) === live && live.activation === activation && live.status === 'running' && !live.settled && !live.settling
    try {
      const res = await live.rpc.command('prompt', { message: forwardedMessage(text, mode, from), streamingBehavior: mode }, { timeoutMs: 10_000 })
      if (!res.success) return { ok: false, error: res.error ?? pick('追加信息没有送达', 'Message was not delivered') }
      if (!current()) return { ok: false, error: pick('子 Agent在发送期间已结束，这条信息可能没有被处理；请再发一次以续接', 'Subagent ended while sending; the message may not have been handled. Send again to resume') }
      const disposition = (res.data as { disposition?: unknown } | undefined)?.disposition
      const delivery = disposition === 'queued' ? 'queued' : 'started'
      live.lastProgressAt = Date.now()
      if (mode === 'followUp') live.followUp = text
      live.latestActivity = delivery === 'queued'
        ? (mode === 'steer' ? pick('已收到追加信息，当前工具结束后处理', 'Message received; handled after the current tool') : pick('已收到追加信息，当前任务做完后处理', 'Message received; handled after the current task'))
        : pick('已收到追加信息', 'Message received')
      this.armWatch(live)
      this.emit(live)
      return { ok: true, run: this.snapshot(live), delivery }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async resume(id: string, text: string, from: SubagentSendFrom): Promise<SubagentSendResult> {
    if (this.reviewing.has(id)) return { ok: false, error: pick('这个子 Agent的改动正在合并或放弃，不能同时续接；处理完再发', 'This subagent\'s changes are being merged or discarded; send again afterwards') }
    if (this.stoppingAll) return { ok: false, error: pick('子 Agent正在停止清理，请稍后重试', 'Subagents are being stopped; try again shortly') }
    if (this.runningCount >= MAX_CONCURRENT) return { ok: false, error: pick(`同时最多运行 ${MAX_CONCURRENT} 个子 Agent（当前 ${this.runningCount} 个），先等一个结束或停掉它`, `At most ${MAX_CONCURRENT} subagents can run at once (${this.runningCount} running); wait for one to finish or stop it`) }
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
    const abandonedError = (): SubagentSendResult => ({ ok: false, error: ticket.cancelled ? pick('续接已被停止', 'Resume was stopped') : pick('子 Agent已被停止或清理，没有续接', 'Subagent was stopped or cleaned up; not resumed') })
    try {
      if (previous?.settling) await previous.settling.catch(() => undefined)
      if (previous?.finalizing) await previous.finalizing.catch(() => undefined)
      if (abandoned()) return abandonedError()
      const record = previous ? this.history.get(id) : await this.history.full(id)
      if (abandoned()) return abandonedError()
      const snapshot = previous ? this.snapshot(previous) : record?.run
      if (!snapshot) return { ok: false, error: pick('找不到这个子 Agent', 'Subagent not found') }
      if (snapshot.status === 'running' || snapshot.status === 'starting') {
        if (previous) return { ok: false, error: pick('子 Agent仍在运行，请再发一次', 'Subagent is still running; send again') }
        return { ok: false, error: pick('这个子 Agent上次运行被中断，不能续接；需要继续时重新派一个，并在任务里附上它的结论', 'This subagent\'s last run was interrupted and cannot be resumed; start a new one and include its findings') }
      }
      const keptWorkspace = !previous && snapshot.isolation === 'worktree' && (snapshot.review === 'pending' || snapshot.review === 'conflict') ? keptWorktreeOf(record) : undefined
      if (snapshot.isolation === 'worktree' && !keptWorkspace && !(previous && worktreeAlive(previous) && existsSync(previous.workspace.cwd))) {
        return { ok: false, error: pick('worktree 子 Agent的工作树已合并、放弃或归档清理，不能在原工作树续改；需要继续时重新派一个，并在任务里附上它的结论', 'This worktree subagent\'s worktree was merged, discarded or archived and cannot be resumed; start a new one and include its findings') }
      }
      if (snapshot.launchFailed) return { ok: false, error: pick('这个子 Agent没有成功启动过，不能续接，请重新派一个', 'This subagent never started successfully and cannot be resumed; start a new one') }
      const sessionFile = await latestSessionFile(this.sessionDir(id))
      if (abandoned()) return abandonedError()
      if (!sessionFile) return { ok: false, error: pick('找不到它的会话记录，不能续接；需要继续时重新派一个，并在任务里附上它的结论', 'Its session record was not found, so it cannot be resumed; start a new one and include its findings') }
      const savedFork = record?.resume?.forkLaunch
      const forkSource = previous?.forkSource ?? (snapshot.fork && savedFork ? restoreForkSource(savedFork, sessionFile) : undefined)
      if (snapshot.fork && !forkSource) return { ok: false, error: pick('这个 fork 子 Agent没有保存来源信息，砚重启后不能续接；需要继续时重新派一个', 'This fork subagent has no saved source and cannot be resumed after a restart; start a new one') }

      const rootCwd = previous?.workspace.rootCwd ?? record?.rootCwd ?? snapshot.cwd
      const workspace: PreparedWorkspace = previous?.workspace ?? keptWorkspace ?? { isolation: snapshot.isolation, rootCwd, cwd: snapshot.cwd }
      const storedLaunch = previous?.launch ?? record?.resume?.launch
      const resolvedLaunch = resolveResumeLaunch(
        storedLaunch ? { launch: storedLaunch, digest: record?.resume?.launchDigest ?? launchDigest(storedLaunch) } : undefined,
        { appendSystemPrompt: this.opts.appendSystemPrompt, extensions: this.opts.extensions, readOnlyExtension: this.opts.readOnlyExtension },
        existsSync
      )
      const ctx: SubagentOptions = { ...this.opts, ...resolvedLaunch.launch, parentSessionId: snapshot.parentSessionId, parentRunId: snapshot.parentRunId, parentGeneration: snapshot.parentGeneration, parentMessageId: snapshot.parentMessageId, projectId: snapshot.projectId, thinkingLevel: snapshot.thinkingLevel }
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
        stderrTail: [],
        ...(forkSource ? { forkSource } : {})
      }
      run.launch = resolvedLaunch.launch
      clearTimeout(run.timer)
      const resumedIn = from === 'parent' && this.opts.parentMessageId && this.opts.parentSessionId === run.parentSessionId ? this.opts.parentMessageId : undefined
      const earlier = [...(run.parentMessageIds ?? []), ...(run.parentMessageId ? [run.parentMessageId] : [])]
      Object.assign(run, {
        ...(resumedIn && resumedIn !== run.parentMessageId ? { parentMessageId: resumedIn, parentMessageIds: [...new Set(earlier)].slice(-20) } : {}),
        rpc, activation, status: 'starting', settled: false, resumed: true, activeSince: now, lastProgressAt: now, followUp: text, quotaWait: undefined, queued: undefined,
        latestActivity: pick('正在续接…', 'Resuming…'), stderrTail: [], runningTools: new Set<string>(),
        contextRevision: (run.contextRevision ?? 0) + 1, diff: undefined, resultPath: undefined,
        settling: undefined, finalizing: undefined, notified: false, reviewDecided: false, worktreeDone: false,
        endedAt: undefined, endReason: undefined, error: undefined, stopReason: undefined, wrapUp: undefined,
        progressWarning: undefined, recovery: undefined, retryAttempt: undefined, retryMaxAttempts: undefined,
        lastModelErrorText: undefined, quotaBounces: undefined, overtimeNoticed: undefined, exitInfo: undefined, streamingId: undefined, dismissedAt: undefined
      })
      this.runs.set(id, run)
      release()
      this.wireRpc(run, rpc)
      this.armWatch(run)
      this.emit(run)

      const current = (status: SubagentRun['status']): boolean => run.rpc === rpc && run.activation === activation && run.status === status
      const stoppedError = (): SubagentSendResult => ({ ok: false, error: run.error ?? pick('子 Agent在续接期间已停止，这条信息没有被处理', 'Subagent stopped while resuming; the message was not handled') })
      try {
        rpc.spawn()
        const ready = await this.waitReady(rpc, 20_000)
        if (!current('starting')) return stoppedError()
        if (ticket.cancelled || generation !== this.launchGeneration) {
          await this.stopRun(run, false)
          return abandonedError()
        }
        if (!ready.ok) {
          await this.fail(id, pick('子 Agent续接超时', 'Subagent resume timed out'), 'startup')
          return { ok: false, error: this.runs.get(id)?.error ?? pick('子 Agent续接超时', 'Subagent resume timed out') }
        }
        if (snapshot.model && ready.model && modelMismatch(snapshot.model, ready.model)) {
          const error = pick(`续接时模型 ${snapshot.model} 没有生效（pi 实际使用 ${ready.model}），请核对登录状态后重试`, `Model ${snapshot.model} was not applied on resume (pi used ${ready.model}); check sign-in and retry`)
          await this.fail(id, error, 'startup')
          return { ok: false, error }
        }
        if (snapshot.model && ready.model) {
          const expectedApi = await ctx.resolveModelApi?.(ready.model, { sessionId: ctx.parentSessionId, runId: ctx.parentRunId })
          if (!current('starting')) return stoppedError()
          const selectionError = await confirmRegisteredModel(rpc, ready.model, { readOnly: workspace.isolation === 'controlled-cwd', expectedApi })
          if (!current('starting')) return stoppedError()
          if (selectionError) {
            await this.fail(id, selectionError, 'startup')
            return { ok: false, error: selectionError }
          }
        }
        if (ready.thinkingLevel) run.thinkingLevel = ready.thinkingLevel
        run.status = 'running'
        run.resumed = false
        run.latestActivity = resolvedLaunch.prefixChanged ? pick('已续接（系统提示或扩展已变，首轮缓存需要重建）', 'Resumed (system prompt or extensions changed; first-turn cache will rebuild)') : pick('已续接', 'Resumed')
        await this.writeMetadata(run)
        if (!current('running')) return stoppedError()
        this.emit(run)
        const res = await rpc.command('prompt', { message: forwardedMessage(text, 'resume', from) }, { timeoutMs: 10_000 })
        if (!current('running')) return stoppedError()
        if (!res.success) {
          await this.fail(id, res.error ?? pick('续接后发送信息失败', 'Could not send the message after resuming'))
          return { ok: false, error: res.error ?? pick('续接后发送信息失败', 'Could not send the message after resuming') }
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
    if (!run) return ticket || this.history.get(id) ? { ok: true } : { ok: false, error: pick('找不到这个子 Agent', 'Subagent not found') }
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
      run.quotaWait = undefined
      run.queued = undefined
      run.endedAt = Date.now()
      run.latestActivity = pick('已停止', 'Stopped')
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
    run.quotaWait = undefined
    run.queued = undefined
    run.error = run.error ?? describeProcessExit(run.exitInfo ?? {}, run.stderrTail)
    run.endedAt = Date.now()
    this.emit(run)
    void this.finalize(run, false).catch((error) => console.warn('[subagent] 收尾失败', error))
  }

  private startupAbort(run: Run): { ok: false; error: string } {
    return { ok: false, error: run.status === 'error' && run.error ? run.error : pick('子 Agent在启动期间已停止', 'Subagent stopped during startup') }
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
    run.quotaWait = undefined
    run.progressWarning = undefined
    if (cancelled) {
      run.queued = undefined
      run.error = undefined
      run.latestActivity = pick('已停止', 'Stopped')
    } else {
      if (run.queued?.length) {
        const unsent = run.queued.length
        run.queued = undefined
        run.error = [reason === 'startup' && run.stderrTail.length ? `${message}；stderr：${run.stderrTail.join(' | ')}` : message, pick(`额度等待期间收下的 ${unsent} 条追加信息没有送出；续接后再发`, `${unsent} queued message(s) were not delivered while waiting for quota; send them again after resuming`)].join('\n')
      } else {
        run.error = reason === 'startup' && run.stderrTail.length ? `${message}；stderr：${run.stderrTail.join(' | ')}` : message
      }
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
      run.pendingOutputs = run.isolation === 'worktree' && collected.ignoredOutputs?.length ? { path: savedOutputsDir(archiveDir, run.id), files: collected.ignoredOutputs } : undefined

      if (run.isolation === 'worktree' && changed) {
        if (cleanupReview) {
          if (!collected.patchPath) throw new Error(pick('未能保存改动补丁，已保留工作区', 'Could not save the patch; workspace kept'))
          run.review = 'archived'
          run.resultPath = collected.patchPath ?? run.workspace.worktreePath
          await this.cleanupRunWorkspace(run)
        } else {
          run.review = 'pending'
          run.resultPath = run.workspace.worktreePath
        }
      } else if (run.isolation === 'worktree' && collected.ignoredOutputs?.length) {
        run.review = 'pending'
        run.resultPath = run.workspace.worktreePath
        run.error = run.error ?? pick(`${ignoredOnlyNote()}（${collected.ignoredOutputs.slice(0, 5).join('、')}${collected.ignoredOutputs.length > 5 ? ' 等' : ''}），无法生成补丁，已保留工作区`, `${ignoredOnlyNote()} (${collected.ignoredOutputs.slice(0, 5).join(', ')}${collected.ignoredOutputs.length > 5 ? ', …' : ''}); no patch could be made, workspace kept`)
      } else {
        run.review = 'none'
        run.resultPath = collected.patchPath
        await this.cleanupRunWorkspace(run)
      }

      await this.writeMetadata(run, collected.patchPath)
    } catch (error) {
      run.review = run.isolation === 'worktree' ? 'conflict' : 'none'
      run.error = run.error ?? pick(`读取子 Agent差异失败：${error instanceof Error ? error.message : String(error)}`, `Could not read the subagent diff: ${error instanceof Error ? error.message : String(error)}`)
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
    this.trimFinished()
  }

  private trimFinished(): void {
    const finished = [...this.runs.values()].filter((run) =>
      run.status !== 'running' && run.status !== 'starting' && run.notified &&
      run.reviewDecided && run.worktreeDone && run.review !== 'pending' && run.review !== 'conflict' &&
      !this.resuming.has(run.id) && !this.reviewing.has(run.id) && !!this.history.get(run.id))
    let excess = finished.length - MAX_FINISHED_IN_MEMORY
    if (excess <= 0) return
    for (const run of finished.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))) {
      if (excess-- <= 0) break
      clearTimeout(run.pushTimer)
      this.runs.delete(run.id)
      this.pushedTranscript.delete(run.id)
    }
  }

  private async cleanupRunWorkspace(run: Run): Promise<PreservedOutputs | undefined> {
    let outputs: PreservedOutputs | undefined
    if (run.isolation === 'worktree') {
      const saved = await preserveIgnoredOutputs(run.workspace, this.opts.archiveDir ?? join(YAN_DIR, 'subagents'), run.id)
      outputs = saved
      if (!saved.ok) {
        run.worktreeDone = false
        run.error = [run.error, pick(`被 .gitignore 忽略的产物没能另存（${saved.error}），已保留工作区：${run.workspace.worktreePath}`, `Outputs ignored by .gitignore could not be saved (${saved.error}); workspace kept: ${run.workspace.worktreePath}`)].filter(Boolean).join('\n')
        return outputs
      }
      run.pendingOutputs = undefined
      if (saved.path) {
        run.savedOutputsPath = saved.path
        if (run.error?.startsWith(ignoredOnlyNote())) run.error = pick(`${ignoredOnlyNote()}，已另存到 ${saved.path}`, `${ignoredOnlyNote()}; saved to ${saved.path}`)
        if (!run.diff?.patchPath) run.resultPath = saved.path
      }
      if (saved.skipped?.length) run.error = [run.error, skippedOutputsNote(saved.skipped)].filter(Boolean).join('\n')
    }
    const result = await cleanupWorkspace(run.workspace)
    run.worktreeDone = result.ok
    if (!result.ok) run.error = [run.error, ...result.errors].filter(Boolean).join('\n')
    return outputs
  }

  private async archiveOnExit(run: Run): Promise<void> {
    if (run.worktreeDone) return

    if (run.isolation === 'worktree' && (run.review === 'pending' || run.review === 'conflict')) {
      try {
        const archiveDir = this.opts.archiveDir ?? join(YAN_DIR, 'subagents')
        const collected = await collectDiff(run.workspace, archiveDir, run.id)
        if (collected.summary.files > 0 && !collected.patchPath) throw new Error(pick('未能保存改动补丁', 'Could not save the patch'))
        run.diff = collected.summary
        run.review = 'archived'
        run.resultPath = collected.patchPath ?? run.workspace.worktreePath
        await this.writeMetadata(run, collected.patchPath)
      } catch (error) {
        run.error = run.error ?? pick(`退出归档失败，已保留工作区：${error instanceof Error ? error.message : String(error)}`, `Archiving on exit failed; workspace kept: ${error instanceof Error ? error.message : String(error)}`)
        this.emit(run)
        return
      }
    }

    await this.cleanupRunWorkspace(run)
    await this.writeMetadata(run)
    this.emit(run)
  }

  private async writeMetadata(run: Run, patchPath?: string): Promise<void> {
    try {
      await this.history.save(this.snapshot(run), run.workspace.rootCwd, {
        limits: { totalMs: run.totalMs, stallTimeoutMs: run.idleMs, graceMs: run.graceMs },
        patchPath: patchPath ?? run.diff?.patchPath,
        ...resumeExtra(run)
      })
    } catch (error) {
      console.warn('[subagent] 保存历史失败', error)
    }
  }

  private async awaitSettled(run: Run): Promise<void> {
    if (run.settling) { try { await run.settling } catch { } }
    if (run.finalizing) { try { await run.finalizing } catch { } }
  }

  private async exclusiveReview(id: string, work: () => Promise<SubagentReviewResult>): Promise<SubagentReviewResult> {
    if (this.resuming.has(id)) return { ok: false, error: pick('子 Agent正在续接，等它结束后再合并或放弃', 'Subagent is resuming; merge or discard after it finishes') }
    if (this.reviewing.has(id)) return { ok: false, error: pick('这个子 Agent的改动正在合并或放弃，请稍候', 'This subagent\'s changes are being merged or discarded; wait a moment') }
    this.reviewing.add(id)
    try {
      return await work()
    } finally {
      this.reviewing.delete(id)
    }
  }

  merge(id: string): Promise<SubagentReviewResult> {
    return this.exclusiveReview(id, () => this.mergeOnce(id))
  }

  discard(id: string): Promise<SubagentReviewResult> {
    return this.exclusiveReview(id, () => this.discardOnce(id))
  }

  private async mergeOnce(id: string): Promise<SubagentReviewResult> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'merged')
    await this.awaitSettled(run)
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: pick('子 Agent仍在运行，结束后才能合并', 'Subagent is still running; merge after it finishes') }
    if (run.review === 'merged') {
      if (run.worktreeDone) return { ok: true }
      const outputs = await this.cleanupRunWorkspace(run)
      await this.writeMetadata(run, run.diff?.patchPath)
      this.emit(run)
      return run.worktreeDone ? { ok: true, ...(outputs ? { outputs } : {}) } : { ok: false, error: mergeCleanupPending(run) }
    }
    if (run.review !== 'pending' && run.review !== 'conflict' && run.review !== 'archived') {
      return { ok: false, error: pick('该任务没有待合并的改动', 'This task has no changes to merge') }
    }
    const patchPath = run.diff?.patchPath
    if (!patchPath || !run.diff?.files) {
      return { ok: false, error: pick('没有可合并的补丁，已保留工作区供检查', 'No patch to merge; workspace kept for inspection') }
    }

    try {
      if (workspaceMutationInProgress(run.workspace.rootCwd)) return workspaceBusy()
      const res = await applyPatchExclusive(run.workspace.rootCwd, patchPath)
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
      const outputs = run.worktreeDone ? undefined : await this.cleanupRunWorkspace(run)
      await this.writeMetadata(run, patchPath)
      this.emit(run)
      return run.worktreeDone ? { ok: true, ...(outputs ? { outputs } : {}) } : { ok: false, error: mergeCleanupPending(run) }
    } catch (error) {
      return { ok: false, error: pick(`合并失败：${error instanceof Error ? error.message : String(error)}`, `Merge failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  private async discardOnce(id: string): Promise<SubagentReviewResult> {
    const run = this.runs.get(id)
    if (!run) return this.reviewHistory(id, 'discarded')
    await this.awaitSettled(run)
    if (run.status === 'running' || run.status === 'starting') return { ok: false, error: pick('子 Agent仍在运行，先停止它', 'Subagent is still running; stop it first') }
    const previousReview = run.review
    try {
      const outputs = run.worktreeDone ? undefined : await this.cleanupRunWorkspace(run)
      if (!run.worktreeDone) {
        const error = run.error ?? pick('清理工作树失败，改动仍未放弃；工作树已保留', 'Could not clean up the worktree; the changes were not discarded and the workspace was kept')
        await this.writeMetadata(run, run.diff?.patchPath)
        this.emit(run)
        return { ok: false, error }
      }
      run.review = 'discarded'
      run.resultPath = run.diff?.patchPath ?? run.savedOutputsPath
      await this.writeMetadata(run, run.diff?.patchPath)
      this.emit(run)
      return { ok: true, ...(outputs ? { outputs } : {}) }
    } catch (error) {
      run.review = previousReview
      return { ok: false, error: pick(`放弃改动失败：${error instanceof Error ? error.message : String(error)}`, `Could not discard changes: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  private async reviewHistory(id: string, review: 'merged' | 'discarded'): Promise<SubagentReviewResult> {
    const record = this.history.get(id)
    if (!record) return { ok: false, error: pick('找不到这个子 Agent', 'Subagent not found') }
    const run = { ...record.run }
    const kept = keptWorktreeOf(record)
    const cleanupRetry = review === 'merged' && run.review === 'merged' && run.isolation === 'worktree' && !!kept
    if (run.review === review && !cleanupRetry) return { ok: true }
    if (review === 'merged' && run.review !== 'merged') {
      if (!['pending', 'conflict', 'archived'].includes(run.review ?? '') || !run.diff?.files || !run.diff.patchPath) {
        return { ok: false, error: pick('历史任务没有可合并的补丁', 'This past task has no patch to merge') }
      }
      const result = await applyPatchExclusive(record.rootCwd, run.diff.patchPath)
      if (!result.ok) return result
      run.review = 'merged'
      run.error = undefined
      await this.history.save(run, record.rootCwd)
      this.opts.onChange(run)
    }
    let outputs: PreservedOutputs | undefined
    if (kept && run.isolation === 'worktree') {
      const saved = await preserveIgnoredOutputs(kept, this.opts.archiveDir ?? join(YAN_DIR, 'subagents'), run.id)
      if (!saved.ok) return { ok: false, error: pick(`被 .gitignore 忽略的产物没能另存（${saved.error}），已保留工作区：${kept.worktreePath}`, `Outputs ignored by .gitignore could not be saved (${saved.error}); workspace kept: ${kept.worktreePath}`), outputs: saved }
      outputs = saved
      const cleaned = await cleanupWorkspace(kept)
      delete run.pendingOutputs
      if (saved.path) run.savedOutputsPath = saved.path
      if (saved.skipped?.length) run.error = [run.error, skippedOutputsNote(saved.skipped)].filter(Boolean).join(String.fromCharCode(10))
      if (!cleaned.ok) {
        run.error = [run.error, ...cleaned.errors].filter(Boolean).join(String.fromCharCode(10))
        if (review === 'merged') run.review = 'merged'
        await this.history.save(run, record.rootCwd)
        this.opts.onChange(run)
        return { ok: false, error: review === 'merged'
          ? pick(`补丁已合并，但工作树没能清理，可再次 merge 只重试清理（不会重复应用补丁）：${cleaned.errors.join('；') || kept.worktreePath}`, `The patch is merged, but the worktree could not be cleaned up; merge again retries the cleanup only (the patch is not applied twice): ${cleaned.errors.join('; ') || kept.worktreePath}`)
          : pick(`工作树没能清理，改动仍未放弃：${cleaned.errors.join('；') || kept.worktreePath}`, `The worktree could not be cleaned up, so the changes were not discarded: ${cleaned.errors.join('; ') || kept.worktreePath}`) }
      }
    }
    run.review = review
    await this.history.save(run, record.rootCwd)
    this.opts.onChange(run)
    return { ok: true, ...(outputs ? { outputs } : {}) }
  }

  private stallLimit(run: Run): number {
    return run.runningTools.size || run.rpc.hasBackgroundWork?.() ? run.idleMs * TOOL_RUNNING_STALL_FACTOR : run.idleMs
  }

  private awaitBackground(run: Run): boolean {
    if (run.status !== 'running' || run.wrapUp || run.stopReason === 'error' || !run.rpc.hasBackgroundWork?.()) return false
    run.awaitingBackground = true
    run.latestActivity = pick('等待后台命令结束', 'Waiting for background commands to finish')
    this.armWatch(run)
    this.emit(run)
    return true
  }

  private backgroundIdle(id: string): void {
    const run = this.runs.get(id)
    if (!run?.awaitingBackground) return
    const since = run.lastProgressAt
    setTimeout(() => {
      if (this.runs.get(id) !== run || !run.awaitingBackground || run.settled || run.lastProgressAt !== since) return
      run.awaitingBackground = false
      this.settle(run)
    }, BACKGROUND_NOTICE_GRACE_MS).unref?.()
  }

  private armWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    clearTimeout(run.timer)
    const at = Math.min(run.totalMs && !run.overtimeNoticed ? run.activeSince + run.totalMs : Infinity, run.lastProgressAt + this.stallLimit(run))
    run.timer = setTimeout(() => this.onWatch(run), Math.max(10, at - Date.now()))
  }

  private onWatch(run: Run): void {
    if (run.wrapUp || (run.status !== 'running' && run.status !== 'starting')) return
    const now = Date.now()
    if (run.totalMs && !run.overtimeNoticed && now >= run.activeSince + run.totalMs) this.noticeOvertime(run, run.totalMs)
    else if (now >= run.lastProgressAt + this.stallLimit(run)) void this.wrapUp(run, stallTimeoutText(this.stallLimit(run)))
    else this.armWatch(run)
  }

  private noticeOvertime(run: Run, totalMs: number): void {
    run.overtimeNoticed = true
    run.progressWarning = overtimeText(totalMs)
    this.emit(run)
    try {
      this.opts.onOvertime?.(this.snapshot(run), Math.round(totalMs / 60_000))
    } catch {
    }
    this.armWatch(run)
  }

  private async wrapUp(run: Run, text: string): Promise<void> {
    if (run.wrapUp || run.settled) return
    if (run.status !== 'running') {
      await this.fail(run.id, text, 'timeout')
      return
    }
    run.wrapUp = { reason: 'timeout', since: Date.now() }
    run.progressWarning = text
    run.latestActivity = pick(`${text}，正在收尾…`, `${text}; wrapping up…`)
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
      run.awaitingBackground = false
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
      if (!raw) {
        if (type === 'message_update') this.applyAssistantDelta(run, evt)
        return
      }

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
          run.latestActivity = pick(`${call.name}${result.status === 'error' ? ' 失败' : ' 完成'}`, `${call.name}${result.status === 'error' ? ' failed' : ' done'}`)
          this.emit(run)
          return
        }
      }

      if (type === 'message_start' || run.streamingId === undefined) {
        run.msgSeq += 1
        run.streamingId = `m${run.msgSeq}`
      }
      if (type === 'message_start' && raw.role === 'assistant') {
        run.streamProjector = new SessionItemProjector()
        run.streamProjector.liveMessageStart({ ...raw, model: undefined }, Date.now())
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
        run.streamProjector = undefined
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
      if (!run.wrapUp) run.latestActivity = pick(`运行 ${String(evt.toolName ?? '工具')}`, `Running ${String(evt.toolName ?? 'tool')}`)
      this.emit(run)
      return
    }

    if (type === 'agent_end') {
      if (this.closedForEvents(run)) return
      if (evt.willRetry === true) {
        run.latestActivity = pick('模型请求失败，等待自动重试…', 'Model request failed; waiting to retry…')
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
      if (this.opts.quotaWatch && isQuotaWaitError(modelErrorText(evt.errorMessage ?? evt.error))) void run.rpc.command('abort_retry').catch(() => undefined)
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
          ? pick(`自动重试失败（已观察到第 ${run.retryAttempt} 次）`, `Auto-retry failed (attempt ${run.retryAttempt} seen)`)
          : pick('自动重试失败', 'Auto-retry failed')
      } else if (evt.success === true) {
        run.error = undefined
        run.stopReason = undefined
        run.lastModelErrorText = undefined
        run.retryAttempt = undefined
        run.recovery = run.recovery?.resumed ? { resumed: true } : undefined
        run.latestActivity = pick('自动重试成功，继续', 'Auto-retry succeeded; continuing')
      } else {
        run.latestActivity = pick('自动重试结束（结果未知）', 'Auto-retry ended (outcome unknown)')
      }
      this.emit(run)
      return
    }

    if (type === 'agent_settled') {
      if (this.closedForEvents(run)) return
      if (this.canWaitForQuota(run)) {
        void this.waitForQuota(run)
        return
      }
      if (this.canResumeAfterModelError(run)) {
        void this.resumeAfterModelError(run)
        return
      }
      if (this.awaitBackground(run)) return
      this.settle(run)
    }
  }

  private applyAssistantDelta(run: Run, evt: Record<string, unknown>): void {
    const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
    const projector = run.streamProjector
    if (!ev || !projector || run.streamingId === undefined) return
    const idx = run.transcript.findIndex((m: UIMessage) => m.id === run.streamingId)
    if (idx < 0) return
    projector.liveAssistantDelta(ev, Date.now())
    const content = projector.streamingContent()
    if (!content) return
    const msg: UIMessage = {
      ...run.transcript[idx],
      text: content.text,
      thinking: content.thinking || undefined,
      toolCalls: content.calls.length ? content.calls : undefined
    }
    run.transcript[idx] = msg
    const usage = toUsage(evt.usage as PiMessage['usage'])
    if (usage) {
      run.usageSnapshots = ingestUsageSnapshot(run.usageSnapshots, run.streamingId, usage)
      run.usage = addUsage(run.baseUsage, accumulateUsage(run.usageSnapshots))
    }
    run.latestActivity = activityOf(msg)
    this.emitStream(run)
  }

  private canWaitForQuota(run: Run): boolean {
    return !!this.opts.quotaWatch && !!run.model && run.status === 'running' && run.stopReason === 'error' && !run.wrapUp &&
      (run.quotaBounces ?? 0) < QUOTA_BOUNCE_LIMIT && isQuotaWaitError(run.lastModelErrorText)
  }

  private async quotaDecision(run: Run): Promise<{ ready: boolean; resetAt?: number; nextCheckAt: number; accounts: number } | null> {
    const info = await this.opts.quotaWatch!.check(run.model!).catch(() => null)
    if (!info?.windows.length) return null
    return { ...decideQuotaResume(info.windows, Date.now()), accounts: info.accounts }
  }

  private async waitForQuota(run: Run): Promise<void> {
    const activation = run.activation
    const live = (): boolean => this.runs.get(run.id) === run && run.activation === activation && run.status === 'running' && !run.settled
    const first = await this.quotaDecision(run)
    if (!live()) return
    if (!first) {
      this.settle(run)
      return
    }
    clearTimeout(run.timer)
    run.quotaBounces = (run.quotaBounces ?? 0) + 1
    if (!first.ready && await this.avoidLongQuotaWait(run, first, live)) return
    if (!live()) return
    run.quotaWait = { since: Date.now(), ...(first.resetAt !== undefined ? { resetAt: first.resetAt } : {}), accounts: first.accounts }
    run.stopReason = undefined
    run.error = undefined
    run.latestActivity = quotaWaitActivity(run.quotaWait)
    this.emit(run)
    try {
      this.opts.quotaWatch!.waiting(this.snapshot(run))
    } catch {
    }
    const schedule = (at: number): void => {
      clearTimeout(run.timer)
      run.timer = setTimeout(() => void tick(), Math.max(1000, at - Date.now()))
    }
    const tick = async (): Promise<void> => {
      if (!live() || !run.quotaWait) return
      const next = await this.quotaDecision(run)
      if (!live() || !run.quotaWait) return
      if (next && !next.ready && await this.avoidLongQuotaWait(run, next, live)) return
      if (!live() || !run.quotaWait) return
      if (!next?.ready) {
        if (next && next.resetAt !== run.quotaWait.resetAt) {
          run.quotaWait = { ...run.quotaWait, ...(next.resetAt !== undefined ? { resetAt: next.resetAt } : {}) }
          run.latestActivity = quotaWaitActivity(run.quotaWait)
          this.emit(run)
        }
        schedule(next?.nextCheckAt ?? Date.now() + QUOTA_RESUME_POLL_MS)
        return
      }
      await this.resumeAfterQuota(run)
    }
    schedule(first.ready ? Date.now() + QUOTA_RESUME_POLL_MS : first.nextCheckAt)
  }

  private async avoidLongQuotaWait(run: Run, decision: { resetAt?: number; accounts: number }, live: () => boolean): Promise<boolean> {
    const remaining = decision.resetAt === undefined ? Infinity : decision.resetAt - Date.now()
    if (remaining <= QUOTA_SWITCH_AFTER_MS) return false
    if (decision.accounts > 1 && await this.trySpareAccount(run, live)) return true
    if (!live() || remaining <= QUOTA_GIVE_UP_AFTER_MS) return !live()
    const reset = decision.resetAt === undefined ? '' : new Date(decision.resetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const resetEn = decision.resetAt === undefined ? '' : new Date(decision.resetAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const noSpare = decision.accounts > 1 ? pick('其他账号也没有额度，', 'no other account has quota, ') : ''
    run.quotaWait = undefined
    run.stopReason = 'error'
    run.error = reset
      ? pick(`额度用完，${noSpare}约 ${reset} 才重置，超过 30 分钟，已停下汇报。额度恢复或换号后可续派，也可以改用别的模型。`, `Quota exhausted; ${noSpare}it resets around ${resetEn}, more than 30 minutes away, so the subagent stopped to report. Resume it after the quota resets or after switching accounts, or use another model.`)
      : pick(`额度用完，${noSpare}查不到重置时间，已停下汇报。额度恢复或换号后可续派，也可以改用别的模型。`, `Quota exhausted; ${noSpare}the reset time is unknown, so the subagent stopped to report. Resume it after the quota resets or after switching accounts, or use another model.`)
    this.settle(run)
    return true
  }

  private async trySpareAccount(run: Run, live: () => boolean): Promise<boolean> {
    const label = await this.opts.quotaWatch!.switchAccount?.(this.snapshot(run)).catch(() => null)
    if (!label || !live()) return false
    await this.resumeAfterQuota(run, pick(`额度用完，已换到 ${label} 继续…`, `Quota exhausted; continuing on ${label}…`), continuationPrompt('account-switch', 'subagent'))
    return true
  }

  private async resumeAfterQuota(run: Run, activity = pick('额度已恢复，继续原任务…', 'Quota restored; continuing the task…'), message = SUBAGENT_QUOTA_RESUME_PROMPT): Promise<void> {
    const waited = run.quotaWait ? Date.now() - run.quotaWait.since : 0
    run.activeSince += waited
    run.quotaWait = undefined
    run.lastModelErrorText = undefined
    run.retryAttempt = undefined
    run.lastProgressAt = Date.now()
    run.latestActivity = activity
    this.armWatch(run)
    this.emit(run)
    try {
      const res = await run.rpc.command('prompt', { message }, { timeoutMs: 10_000 })
      if (!res.success) {
        await this.fail(run.id, res.error ?? pick('额度恢复后续跑失败', 'Could not continue after quota recovery'))
        return
      }
      while (run.queued?.length) {
        if (run.status !== 'running' || run.settled) return
        const item = run.queued[0]
        const sent = await run.rpc.command('prompt', { message: forwardedMessage(item.text, item.mode, item.from), streamingBehavior: item.mode }, { timeoutMs: 10_000 })
        if (!sent.success) {
          await this.fail(run.id, sent.error ?? pick('额度恢复后送出排队的追加信息失败', 'Could not deliver a queued message after quota recovery'))
          return
        }
        run.queued.shift()
      }
    } catch (error) {
      await this.fail(run.id, error instanceof Error ? error.message : String(error))
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
    run.latestActivity = pick('模型请求中断且未自动重试，正在同一会话自动续跑（1/1）…', 'Model request interrupted without retry; continuing in the same session (1/1)…')
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
      const res = await run.rpc.command('prompt', { message: continuationPrompt('model-error', 'subagent') }, { timeoutMs: 10_000 })
      if (!res.success) failed()
    } catch {
      failed()
    }
  }

  private settle(run: Run): void {
    run.settled = true
    clearTimeout(run.timer)
    const unsent = run.queued?.length ?? 0
    run.queued = undefined
    run.quotaWait = undefined
    const modelFailed = run.status !== 'cancelled' && run.stopReason === 'error'
    const wrapped = run.status !== 'cancelled' && !modelFailed ? run.wrapUp : undefined
    run.status = run.status === 'cancelled' ? 'cancelled' : modelFailed ? 'error' : 'done'
    run.endReason = run.status === 'cancelled' ? 'stopped' : modelFailed ? 'model-error' : (wrapped?.reason ?? 'completed')
    run.wrapUp = undefined
    run.progressWarning = undefined
    run.endedAt = Date.now()
    if (modelFailed) run.error = run.error ?? modelErrorNotice(undefined)
    if (unsent) {
      run.error = [run.error, pick(`额度等待期间收下的 ${unsent} 条追加信息没有送出；续接后再发`, `${unsent} queued message(s) were not delivered while waiting for quota; send them again after resuming`)].filter(Boolean).join('\n')
    }
    run.latestActivity = modelFailed
      ? modelFailureActivity(run.recovery)
      : wrapped ? pick('超时，已收尾', 'Timed out; wrapped up') : pick('已完成', 'Done')
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

function usableParentSession(id: string | undefined): string | undefined {
  return id && !id.startsWith('pending:') ? id : undefined
}

export function approvalOriginFor(
  live: { parentSessionId?: string; parentRunId?: string } | undefined,
  fallback: { parentSessionId?: string; parentRunId?: string },
  subagentId: string
): SubagentApprovalOrigin {
  const sessionId = usableParentSession(live?.parentSessionId ?? fallback.parentSessionId)
  const runId = live?.parentRunId ?? fallback.parentRunId
  return { ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}), subagentId }
}

function modelLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { provider, id } = raw as { provider?: unknown; id?: unknown }
  if (typeof id !== 'string' || !id) return undefined
  return typeof provider === 'string' && provider ? `${provider}/${id}` : id
}

function modelMismatch(requested: string, actual: string): boolean {
  const cut = requested.lastIndexOf(':')
  const want = (cut > 0 && THINKING_LEVELS.includes(requested.slice(cut + 1).trim().toLowerCase()) ? requested.slice(0, cut) : requested).trim()
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
  return `${label}${timing}；Stay within the original task.\n\n${text}`
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

function keptWorktreeOf(record: SubagentHistoryRecord | undefined): PreparedWorkspace | undefined {
  const workspace = record?.resume?.workspace
  return workspace?.worktreePath && existsSync(workspace.worktreePath) ? workspace : undefined
}

function worktreeAlive(run: Run): boolean {
  return run.isolation === 'worktree' && !run.worktreeDone && (run.review === 'pending' || run.review === 'conflict')
}

function resumeExtra(run: Run): { resume?: ResumeMeta } {
  const meta: ResumeMeta = {}
  if (run.launch) {
    meta.launch = run.launch
    meta.launchDigest = launchDigest(run.launch)
  }
  if (run.forkSource) meta.forkLaunch = persistableForkLaunch(run.forkSource)
  if (run.isolation === 'worktree' && run.workspace.worktreePath) meta.workspace = run.workspace
  return Object.keys(meta).length ? { resume: meta } : {}
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


function quotaWaitActivity(wait: NonNullable<SubagentRun['quotaWait']>): string {
  const reset = wait.resetAt !== undefined ? pick(`（约 ${new Date(wait.resetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置）`, `(resets around ${new Date(wait.resetAt).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`) : ''
  return wait.accounts > 1
    ? pick(`额度用尽${reset}：可在额度页换号，换号或额度恢复后自动继续`, `Quota exhausted${reset}: switch account on the quota page, or it continues when quota is restored`)
    : pick(`额度用尽，等额度恢复${reset}后自动继续`, `Quota exhausted; continues automatically when quota is restored${reset}`)
}

function modelFailureActivity(recovery: SubagentRecovery | undefined): string {
  if (recovery?.resumed) return pick('自动续跑 1 次后仍失败', 'Still failing after 1 auto-continue')
  if (recovery?.piRetries) return pick(`自动重试 ${recovery.piRetries} 次后仍失败`, `Still failing after ${recovery.piRetries} auto-retries`)
  return pick('模型返回错误（未自动重试）', 'Model returned an error (no auto-retry)')
}

function retryActivity(attempt: number | undefined, maxAttempts: number | undefined): string {
  if (attempt === undefined) return pick('模型请求失败，正在自动重试…', 'Model request failed; retrying…')
  return maxAttempts === undefined || maxAttempts < attempt
    ? pick(`模型请求失败，正在自动重试（第 ${attempt} 次）`, `Model request failed; retrying (attempt ${attempt})`)
    : pick(`模型请求失败，正在自动重试（第 ${attempt}/${maxAttempts} 次）`, `Model request failed; retrying (attempt ${attempt}/${maxAttempts})`)
}

function activityOf(msg: UIMessage): string {
  if (msg.role === 'assistant') {
    const first = msg.text.split('\n').map((x) => x.trim()).find(Boolean)
    if (first) return first.slice(0, 80)
    if (msg.toolCalls?.length) return pick(`调用 ${msg.toolCalls[msg.toolCalls.length - 1].name}`, `Calling ${msg.toolCalls[msg.toolCalls.length - 1].name}`)
    if (msg.thinking) return pick('推理中…', 'Thinking…')
    return pick('生成中…', 'Generating…')
  }
  return msg.text.split('\n').find(Boolean)?.slice(0, 80) ?? pick('处理中…', 'Working…')
}
