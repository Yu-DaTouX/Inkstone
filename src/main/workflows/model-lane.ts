import { pick } from '../../shared/ui-lang'
import { isRateLimitError, isQuotaWaitError } from '../../shared/quota-resume'
import { isTransientModelError } from '../../shared/model-errors'
import { WORKFLOW_LIMITS, emptyModelStats, type WorkflowModelPhaseStat, type WorkflowModelStats } from '../../shared/workflows'
import type { ModelCallRequest, ModelCallResult } from '../model-call'
import type { JournalEntry, JournalWriter, ModelReplay } from './journal'
import { modelPromptHash, type WorkflowModelOptions } from './model-options'
import type { AgentReply } from './sandbox'
import { extractJson, schemaInstruction, validateJson } from './schema'

export interface WorkflowQuotaDecision {
  ready: boolean
  resetAt?: number
  nextCheckAt: number
}

export interface WorkflowModelHost {
  call(req: ModelCallRequest): Promise<ModelCallResult>
  quota?(model: string): Promise<WorkflowQuotaDecision | null>
}

export interface WorkflowModelLaneOptions {
  host?: WorkflowModelHost
  replay: ModelReplay
  journal: JournalWriter
  attempt: number
  concurrency: number
  defaultModel?: string
  backoffMs?: number
  signal: AbortSignal
  now(): number
  phase(): string | undefined
  blocked(): boolean
  reply(seq: number, reply: AgentReply): void
  onChange(): void
}

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

interface ModelJob {
  seq: number
  prompt: string
  options: WorkflowModelOptions
  hash: string
  model: string
  phase?: string
  status: JobStatus
}

export const MODEL_QUOTA_WAIT_LIMIT_MS = 30 * 60_000
const MODEL_QUOTA_BOUNCES = 3
const MAX_BACKOFF_MS = 60_000
const STOP_GRACE_MS = 5000

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, Math.max(10, ms))
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function kindOf(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind
  return typeof kind === 'string' ? kind : undefined
}

function resetText(at: number | undefined): string {
  if (at === undefined) return pick('查不到重置时间', 'the reset time is unknown')
  const when = (lang: string): string => new Date(at).toLocaleString(lang, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return pick(`约 ${when('zh-CN')} 才重置`, `it resets around ${when('en-US')}`)
}

export class WorkflowModelLane {
  private readonly queue: ModelJob[] = []
  private readonly inflight = new Map<ModelJob, Promise<void>>()
  private readonly counts: WorkflowModelStats = emptyModelStats()
  private readonly holds = new Map<string, number>()
  private readonly phases = new Map<string, WorkflowModelPhaseStat>()
  private waiting = 0

  constructor(private readonly opts: WorkflowModelLaneOptions) {}

  stats(): WorkflowModelStats {
    const { total, done, cached, failed, stopped, running, queued } = this.counts
    const phases = [...this.phases.values()].map((stat) => ({ ...stat }))
    return { total, done, cached, failed, stopped, running, queued, ...(this.waiting > 0 ? { waitingQuota: true } : {}), ...(phases.length ? { phases } : {}) }
  }

  private phaseStat(title: string | undefined): WorkflowModelPhaseStat {
    const key = title ?? ''
    let stat = this.phases.get(key)
    if (!stat) {
      stat = { title: key, total: 0, done: 0, failed: 0, stopped: 0, running: 0, queued: 0 }
      this.phases.set(key, stat)
    }
    return stat
  }

  private move(job: Pick<ModelJob, 'phase'>, from: 'queued' | 'running' | null, to: 'queued' | 'running' | 'done' | 'failed' | 'stopped'): void {
    const stat = this.phaseStat(job.phase)
    if (from) stat[from] -= 1
    else stat.total += 1
    stat[to] += 1
  }

  add(seq: number, prompt: string, options: WorkflowModelOptions): void {
    const hash = modelPromptHash(prompt, options)
    const phase = this.opts.phase()
    this.counts.total += 1
    const hit = this.opts.replay.take(seq, hash)
    if (hit) {
      this.counts.cached += 1
      this.move({ phase }, null, 'done')
      void this.opts.journal.append({ ...hit, kind: 'model', seq, attempt: this.opts.attempt, at: this.opts.now(), cached: true, ...(options.label ? { label: options.label } : {}), ...(phase ? { phase } : {}) })
      this.opts.reply(seq, { ok: true, json: JSON.stringify(hit.result ?? null) })
      this.opts.onChange()
      return
    }
    const model = options.model ?? this.opts.defaultModel ?? ''
    const job: ModelJob = { seq, prompt, options, hash, model, ...(phase ? { phase } : {}), status: 'queued' }
    this.counts.queued += 1
    this.move(job, null, 'queued')
    if (!this.opts.host) {
      this.settle(job, 'failed', { error: pick('这个运行没有接上直接模型调用', 'This run has no direct model call host') })
      return
    }
    if (!model) {
      this.settle(job, 'failed', { error: pick('没有可用的模型：发起工作流的会话没有当前模型，给 model() 传 model 选项（例如 provider/model-id）', 'No model available: the session that started the workflow had no current model; pass the model option to model() (for example provider/model-id)') })
      return
    }
    this.queue.push(job)
    this.opts.onChange()
    this.pump()
  }

  pump(): void {
    while (!this.opts.blocked() && !this.opts.signal.aborted && this.queue.length && this.inflight.size < this.opts.concurrency) {
      const job = this.queue.shift()!
      job.status = 'running'
      this.counts.queued -= 1
      this.counts.running += 1
      this.move(job, 'queued', 'running')
      const run = this.execute(job)
        .catch((error: unknown) => this.settle(job, 'failed', { error: messageOf(error) }))
        .finally(() => {
          this.inflight.delete(job)
          this.pump()
        })
      this.inflight.set(job, run)
    }
    this.opts.onChange()
  }

  async stop(): Promise<void> {
    for (const job of this.queue.splice(0)) {
      job.status = 'stopped'
      this.counts.queued -= 1
      this.counts.stopped += 1
      this.move(job, 'queued', 'stopped')
    }
    const live = [...this.inflight.entries()]
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(live.map(([, run]) => run)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_GRACE_MS)
      })
    ])
    clearTimeout(timer)
    for (const [job] of live) this.settle(job, 'stopped', { error: pick('已停止', 'Stopped') })
  }

  private entry(job: ModelJob, extra: Partial<JournalEntry> & Pick<JournalEntry, 'status'>): JournalEntry {
    return {
      kind: 'model',
      seq: job.seq,
      hash: job.hash,
      attempt: this.opts.attempt,
      at: this.opts.now(),
      model: job.model,
      ...(job.options.label ? { label: job.options.label } : {}),
      ...(job.phase ? { phase: job.phase } : {}),
      ...extra
    }
  }

  private settle(job: ModelJob, status: 'done' | 'failed' | 'stopped', detail: { result?: unknown; error?: string; usage?: unknown; stopReason?: string; model?: string }): void {
    if (job.status === 'done' || job.status === 'failed' || job.status === 'stopped') return
    if (job.status === 'running') this.counts.running -= 1
    else this.counts.queued -= 1
    this.move(job, job.status === 'running' ? 'running' : 'queued', status)
    job.status = status
    this.counts[status] += 1
    const where = job.options.label ? `"${job.options.label}"` : `#${job.seq}`
    const error = detail.error ? (status === 'failed' ? pick(`model() 调用 ${where} 失败：${detail.error}`, `model() call ${where} failed: ${detail.error}`) : detail.error) : undefined
    void this.opts.journal.append(this.entry(job, {
      status,
      ...(status === 'done' ? { result: detail.result ?? null } : {}),
      ...(error ? { error } : {}),
      ...(detail.usage ? { usage: detail.usage } : {}),
      ...(detail.stopReason ? { stopReason: detail.stopReason } : {}),
      ...(detail.model ? { model: detail.model } : {})
    }))
    if (status === 'done') this.opts.reply(job.seq, { ok: true, json: JSON.stringify(detail.result ?? null) })
    else if (status === 'stopped') this.opts.reply(job.seq, { ok: false, stopped: true, error: error ?? pick('已停止', 'Stopped') })
    else this.opts.reply(job.seq, { ok: false, error: error ?? pick('model() 调用失败', 'model() call failed') })
    this.opts.onChange()
  }

  private async holdFor(model: string): Promise<void> {
    for (;;) {
      const until = this.holds.get(model) ?? 0
      const now = this.opts.now()
      if (until <= now || this.opts.signal.aborted) return
      await pause(until - now, this.opts.signal)
    }
  }

  private async waitQuota(model: string): Promise<{ ready: true } | { ready: false; reason: string }> {
    const host = this.opts.host!
    if (!host.quota) return { ready: false, reason: pick('查不到这个模型的额度信息，没有排队等待', 'no quota information for this model, so it did not wait') }
    for (;;) {
      if (this.opts.signal.aborted) return { ready: false, reason: pick('已停止', 'Stopped') }
      const decision = await host.quota(model).catch(() => null)
      if (this.opts.signal.aborted) return { ready: false, reason: pick('已停止', 'Stopped') }
      if (!decision) return { ready: false, reason: pick('查不到这个模型的额度信息，没有排队等待', 'no quota information for this model, so it did not wait') }
      if (decision.ready) return { ready: true }
      const remaining = decision.resetAt === undefined ? Number.POSITIVE_INFINITY : decision.resetAt - this.opts.now()
      if (remaining > MODEL_QUOTA_WAIT_LIMIT_MS) return { ready: false, reason: pick(`额度${resetText(decision.resetAt)}，超过 30 分钟，没有排队等待；额度恢复或换号后用 yan workflow resume 续跑，或给 model() 换模型`, `quota: ${resetText(decision.resetAt)}, more than 30 minutes away, so it did not wait; resume with yan workflow resume after the quota resets or after switching accounts, or give model() another model`) }
      const until = Math.max(this.opts.now() + 10, decision.nextCheckAt)
      this.holds.set(model, Math.max(this.holds.get(model) ?? 0, until))
      this.waiting += 1
      this.opts.onChange()
      try {
        await pause(until - this.opts.now(), this.opts.signal)
      } finally {
        this.waiting -= 1
        this.opts.onChange()
      }
    }
  }

  private async execute(job: ModelJob): Promise<void> {
    const signal = this.opts.signal
    const host = this.opts.host!
    const retries = job.options.retries ?? WORKFLOW_LIMITS.defaultModelRetries
    const timeoutMs = (job.options.timeoutMinutes ?? WORKFLOW_LIMITS.defaultModelTimeoutMinutes) * 60_000
    const schema = job.options.schema
    const prompt = schema ? `${job.prompt}${schemaInstruction(schema)}` : job.prompt
    const base = this.opts.backoffMs ?? 2000
    let tries = 0
    let bounces = 0
    for (;;) {
      await this.holdFor(job.model)
      if (signal.aborted) return this.settle(job, 'stopped', { error: pick('已停止', 'Stopped') })
      let result: ModelCallResult
      try {
        result = await host.call({
          model: job.model,
          prompt,
          ...(job.options.system ? { system: job.options.system } : {}),
          ...(job.options.thinking ? { thinking: job.options.thinking } : {}),
          timeoutMs,
          signal
        })
      } catch (error) {
        if (signal.aborted || kindOf(error) === 'cancelled') return this.settle(job, 'stopped', { error: pick('已停止', 'Stopped') })
        const message = messageOf(error)
        if (isQuotaWaitError(message)) {
          const waited = bounces < MODEL_QUOTA_BOUNCES ? await this.waitQuota(job.model) : { ready: false as const, reason: pick(`等额度后又撞上额度上限 ${MODEL_QUOTA_BOUNCES} 次`, `hit the quota limit again ${MODEL_QUOTA_BOUNCES} times after waiting`) }
          if (signal.aborted) return this.settle(job, 'stopped', { error: pick('已停止', 'Stopped') })
          if (waited.ready) {
            bounces += 1
            continue
          }
          return this.settle(job, 'failed', { error: pick(`${message}（${waited.reason}）`, `${message} (${waited.reason})`) })
        }
        const rate = isRateLimitError(message)
        if (tries < retries && (kindOf(error) === 'timeout' || rate || isTransientModelError(message))) {
          tries += 1
          await pause(Math.min(MAX_BACKOFF_MS, base * 2 ** (tries - 1) * (rate ? 5 : 1)), signal)
          continue
        }
        return this.settle(job, 'failed', { error: message })
      }
      const meta = { ...(result.usage ? { usage: result.usage } : {}), ...(result.stopReason ? { stopReason: result.stopReason } : {}), ...(result.model ? { model: result.model } : {}) }
      if (!schema) return this.settle(job, 'done', { result: result.text, ...meta })
      const extracted = extractJson(result.text)
      const errors = extracted.ok ? validateJson(extracted.value, schema) : [extracted.error]
      if (extracted.ok && !errors.length) return this.settle(job, 'done', { result: extracted.value, ...meta })
      return this.settle(job, 'failed', { error: pick(`输出没有通过 JSON schema 校验：${errors.join('；')}`, `Output did not pass JSON schema validation: ${errors.join('; ')}`), ...meta })
    }
  }
}
