import { Worker } from 'node:worker_threads'
import type { SubagentRun } from '../../shared/ipc'
import { WORKFLOW_LIMITS, type WorkflowAgentView } from '../../shared/workflows'
import { promptHash, subagentStartParams, type WorkflowAgentOptions } from './agent-options'
import { JournalWriter, Replay, type JournalEntry } from './journal'
import type { HostToWorker, WorkerToHost } from './protocol'
import type { AgentReply } from './sandbox'
import { extractJson, schemaCorrection, validateJson } from './schema'
import type { SlotGate } from './slots'

export interface WorkflowSubagentHost {
  start(params: Record<string, unknown>): Promise<string>
  send(id: string, message: string): Promise<void>
  stop(id: string): Promise<void>
  waitFinished(id: string, after: number, signal: AbortSignal): Promise<SubagentRun | null>
}

export type WorkflowOutcome =
  | { status: 'done'; json: string }
  | { status: 'failed'; error: string }
  | { status: 'stopped' }

export interface WorkflowRunnerOptions {
  workerPath: string
  code: string
  argsJson?: string
  journalFile: string
  attempt: number
  concurrency: number
  previous: Map<number, JournalEntry>
  host: WorkflowSubagentHost
  slots: SlotGate
  maxAgents?: number
  maxItems?: number
  schemaRetries?: number
  requeueDelayMs?: number
  onChange(): void
  onFinish(outcome: WorkflowOutcome): void
  now?(): number
}

interface Job {
  seq: number
  prompt: string
  options: WorkflowAgentOptions
  hash: string
  view: WorkflowAgentView
  requeues: number
}

const CAPACITY_ERROR = /同时最多运行|At most \d+ subagents can run/
const MAX_REQUEUES = 50
const MAX_LOG_CHARS = 500

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function finalMessage(run: Pick<SubagentRun, 'transcript'>): string {
  for (let i = run.transcript.length - 1; i >= 0; i -= 1) {
    const msg = run.transcript[i]
    if (msg.role === 'assistant' && msg.text.trim()) return msg.text.trim()
  }
  return ''
}

export class WorkflowRunner {
  readonly agents: WorkflowAgentView[] = []
  readonly logs: string[] = []
  paused = false
  private phase: string | undefined
  private worker: Worker | null = null
  private readonly queue: Job[] = []
  private readonly inflight = new Map<number, Job>()
  private readonly subagents = new Map<number, string>()
  private readonly abort = new AbortController()
  private readonly journal: JournalWriter
  private readonly replay: Replay
  private finished = false
  private stopping: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly opts: WorkflowRunnerOptions) {
    this.journal = new JournalWriter(opts.journalFile)
    this.replay = new Replay(opts.previous)
    this.now = opts.now ?? Date.now
  }

  get done(): boolean {
    return this.finished
  }

  liveSubagentIds(): string[] {
    return [...this.inflight.keys()].map((seq) => this.subagents.get(seq)).filter((id): id is string => !!id)
  }

  start(): void {
    const worker = new Worker(this.opts.workerPath, {
      workerData: {
        code: this.opts.code,
        argsJson: this.opts.argsJson,
        maxAgents: this.opts.maxAgents ?? WORKFLOW_LIMITS.maxAgents,
        maxItems: this.opts.maxItems ?? WORKFLOW_LIMITS.maxItems
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    })
    this.worker = worker
    worker.on('message', (message: WorkerToHost) => this.onMessage(message))
    worker.on('error', (error) => void this.end({ status: 'failed', error: `脚本运行环境出错：${error instanceof Error ? error.message : String(error)}` }))
    worker.on('exit', (code) => {
      if (!this.finished) void this.end({ status: 'failed', error: `脚本运行环境意外退出（code=${code}）` })
    })
  }

  pause(): void {
    if (this.finished) return
    this.paused = true
    this.opts.onChange()
  }

  resume(): void {
    if (this.finished) return
    this.paused = false
    this.opts.onChange()
    this.pump()
  }

  stop(): Promise<void> {
    return this.end({ status: 'stopped' })
  }

  private onMessage(message: WorkerToHost): void {
    if (this.finished || !message || typeof message !== 'object') return
    switch (message.type) {
      case 'agent':
        this.onAgent(message.seq, message.prompt, message.options)
        break
      case 'phase':
        this.phase = message.title
        this.opts.onChange()
        break
      case 'log':
        this.logs.push(String(message.text).slice(0, MAX_LOG_CHARS))
        if (this.logs.length > WORKFLOW_LIMITS.maxLogs) this.logs.splice(0, this.logs.length - WORKFLOW_LIMITS.maxLogs)
        this.opts.onChange()
        break
      case 'fatal':
        void this.end({ status: 'failed', error: message.error })
        break
      case 'done':
        void this.end({ status: 'done', json: message.json })
        break
      case 'failed':
        void this.end({ status: 'failed', error: message.error })
        break
    }
  }

  private reply(seq: number, reply: AgentReply): void {
    if (this.finished || !this.worker) return
    const message: HostToWorker = { type: 'agent-result', seq, reply }
    try {
      this.worker.postMessage(message)
    } catch {
    }
  }

  private onAgent(seq: number, prompt: string, options: WorkflowAgentOptions): void {
    const maxAgents = this.opts.maxAgents ?? WORKFLOW_LIMITS.maxAgents
    if (!Number.isInteger(seq) || seq < 0 || seq >= maxAgents) {
      void this.end({ status: 'failed', error: `超过单次运行最多 ${maxAgents} 个 agent() 调用的上限` })
      return
    }
    const hash = promptHash(prompt, options)
    const view: WorkflowAgentView = { seq, ...(options.label ? { label: options.label } : {}), ...(this.phase ? { phase: this.phase } : {}), status: 'queued' }
    this.agents[seq] = view
    const decision = this.replay.take(seq, hash)
    if ('hit' in decision) {
      view.status = 'cached'
      if (decision.hit.subagentId) view.subagentId = decision.hit.subagentId
      void this.journal.append({ ...decision.hit, attempt: this.opts.attempt, at: this.now(), cached: true, ...(view.label ? { label: view.label } : {}), ...(view.phase ? { phase: view.phase } : {}) })
      this.reply(seq, { ok: true, json: JSON.stringify(decision.hit.result ?? null) })
      this.opts.onChange()
      return
    }
    if (decision.mark) void this.journal.append({ type: 'diverged', seq, attempt: this.opts.attempt, at: this.now() })
    this.queue.push({ seq, prompt, options, hash, view, requeues: 0 })
    this.opts.onChange()
    this.pump()
  }

  private pump(): void {
    while (!this.finished && !this.paused && this.queue.length && this.inflight.size < this.opts.concurrency) {
      const job = this.queue.shift()!
      this.inflight.set(job.seq, job)
      void this.execute(job).catch((error: unknown) => this.settleAgent(job, 'failed', { error: error instanceof Error ? error.message : String(error) })).finally(() => {
        if (this.inflight.get(job.seq) === job) this.inflight.delete(job.seq)
        this.pump()
      })
    }
  }

  private entry(job: Job, extra: Partial<JournalEntry> & Pick<JournalEntry, 'status'>): JournalEntry {
    const id = this.subagents.get(job.seq)
    return {
      seq: job.seq,
      hash: job.hash,
      attempt: this.opts.attempt,
      at: this.now(),
      ...(id ? { subagentId: id } : {}),
      ...(job.view.label ? { label: job.view.label } : {}),
      ...(job.view.phase ? { phase: job.view.phase } : {}),
      ...extra
    }
  }

  private settleAgent(job: Job, status: 'done' | 'failed' | 'stopped', detail: { result?: unknown; error?: string }): void {
    if (job.view.status === 'done' || job.view.status === 'failed' || job.view.status === 'stopped') return
    job.view.status = status
    if (detail.error) job.view.error = detail.error.slice(0, 300)
    void this.journal.append(this.entry(job, { status, ...(status === 'done' ? { result: detail.result ?? null } : {}), ...(detail.error ? { error: detail.error } : {}) }))
    if (status === 'done') this.reply(job.seq, { ok: true, json: JSON.stringify(detail.result ?? null) })
    else if (status === 'stopped') this.reply(job.seq, { ok: false, stopped: true, error: detail.error ?? '已停止' })
    else this.reply(job.seq, { ok: false, error: detail.error ?? '子代理失败' })
    this.opts.onChange()
  }

  private async execute(job: Job): Promise<void> {
    const signal = this.abort.signal
    let id: string | undefined
    while (!id) {
      const release = await this.opts.slots.acquire(signal)
      if (!release) return
      try {
        if (this.finished) return
        id = await this.opts.host.start(subagentStartParams(job.prompt, job.options))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.finished) return
        if (CAPACITY_ERROR.test(message) && job.requeues < MAX_REQUEUES) {
          job.requeues += 1
          release()
          await pause(this.opts.requeueDelayMs ?? 2000, signal)
          continue
        }
        this.settleAgent(job, 'failed', { error: message })
        return
      } finally {
        release()
      }
    }
    this.subagents.set(job.seq, id)
    job.view.subagentId = id
    if (this.finished) {
      job.view.status = 'stopped'
      await this.opts.host.stop(id).catch(() => undefined)
      await this.journal.append(this.entry(job, { status: 'stopped' }))
      return
    }
    job.view.status = 'running'
    void this.journal.append(this.entry(job, { status: 'running' }))
    this.opts.onChange()
    const schema = job.options.schema
    const maxRetries = this.opts.schemaRetries ?? WORKFLOW_LIMITS.schemaRetries
    let after = 0
    let retries = 0
    for (;;) {
      const run = await this.opts.host.waitFinished(id, after, signal)
      if (!run || this.finished) return
      after = run.endedAt ?? this.now()
      if (run.status === 'cancelled') {
        this.settleAgent(job, 'stopped', { error: '子代理被停止' })
        return
      }
      if (run.status !== 'done') {
        this.settleAgent(job, 'failed', { error: run.error?.trim() || '子代理失败' })
        return
      }
      const text = finalMessage(run)
      if (!schema) {
        this.settleAgent(job, 'done', { result: text })
        return
      }
      const extracted = extractJson(text)
      const errors = extracted.ok ? validateJson(extracted.value, schema) : [extracted.error]
      if (!errors.length && extracted.ok) {
        this.settleAgent(job, 'done', { result: extracted.value })
        return
      }
      if (retries >= maxRetries) {
        this.settleAgent(job, 'failed', { error: `续接 ${retries} 次后仍没通过 schema 校验：${errors.join('；')}` })
        return
      }
      retries += 1
      job.view.retries = retries
      this.opts.onChange()
      const release = await this.opts.slots.acquire(signal)
      if (!release) return
      try {
        if (this.finished) return
        await this.opts.host.send(id, schemaCorrection(errors, schema))
      } catch (error) {
        this.settleAgent(job, 'failed', { error: `续接子代理失败：${error instanceof Error ? error.message : String(error)}` })
        return
      } finally {
        release()
      }
    }
  }

  private end(outcome: WorkflowOutcome): Promise<void> {
    if (this.stopping) return this.stopping
    this.finished = true
    const queued = this.queue.splice(0)
    const live = [...this.inflight.values()]
    this.inflight.clear()
    this.abort.abort()
    const worker = this.worker
    this.worker = null
    this.stopping = (async () => {
      if (worker) await worker.terminate().catch(() => undefined)
      for (const job of queued) job.view.status = 'stopped'
      await Promise.all(live.map(async (job) => {
        const id = this.subagents.get(job.seq)
        if (id) await this.opts.host.stop(id).catch(() => undefined)
        if (job.view.status === 'running' || job.view.status === 'queued') {
          job.view.status = 'stopped'
          if (id) await this.journal.append(this.entry(job, { status: 'stopped' }))
        }
      }))
      await this.journal.flush()
      this.opts.onChange()
      this.opts.onFinish(outcome)
    })()
    return this.stopping
  }
}
