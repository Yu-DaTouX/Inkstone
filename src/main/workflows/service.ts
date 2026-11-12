import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SubagentRun } from '../../shared/ipc'
import {
  WORKFLOW_LIMITS,
  isLiveWorkflow,
  normalizeWorkflowId,
  workflowAnchor,
  workflowIdOfAnchor,
  workflowPhaseStats,
  workflowTotals,
  type WorkflowRunView,
  type WorkflowStatus
} from '../../shared/workflows'
import { pick } from '../../shared/ui-lang'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import type { NoticeTarget } from '../subagent-notify'
import { readJournal } from './journal'
import { buildWorkflowNotice, createWorkflowNotifier, type WorkflowNotifier, type WorkflowWorktree } from './notice'
import { WorkflowRunner, type WorkflowOutcome } from './runner'
import { checkWorkflowScript } from './script'
import { SlotGate } from './slots'

export interface WorkflowContext {
  model?: string
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  projectId?: string
}

export interface WorkflowServiceDeps {
  root: string
  workerPath: string
  subagentCommand(command: string, params: Record<string, unknown>, context: WorkflowContext): Promise<{ data?: unknown; summary: Record<string, unknown> }>
  getSubagent(id: string): Promise<SubagentRun | undefined>
  runningSubagents(): number
  findTarget(run: WorkflowRunView): NoticeTarget | null
  push(view: WorkflowRunView): void
  now?(): number
  waitPollMs?: number
  slotPollMs?: number
  noticePollMs?: number
  pushDelayMs?: number
}

interface WorkflowRecord {
  view: WorkflowRunView
  context: WorkflowContext
  argsJson?: string
  notified?: boolean
}

interface FinishWaiter {
  after: number
  resolve(run: SubagentRun | null): void
}

const RECORD_FILE = 'run.json'
const SCRIPT_FILE = 'script.js'
const JOURNAL_FILE = 'journal.jsonl'
const RESULT_FILE = 'result.json'
const MAX_ARGS_CHARS = 200_000
const MAX_LISTED = 200
const SUMMARY_RESULT_CHARS = 400
const TERMINAL = new Set(['done', 'error', 'cancelled'])

function sessionKey(context: WorkflowContext): string {
  const raw = context.parentSessionId || (context.parentRunId ? `pending:${context.parentRunId}` : 'detached')
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'detached'
}

function isRecord(value: unknown): value is WorkflowRecord {
  const box = value as WorkflowRecord | null
  return !!box && typeof box === 'object' && !!box.view && typeof box.view.id === 'string' && !!normalizeWorkflowId(box.view.id) && !!box.context && typeof box.context.cwd === 'string'
}

function intParam(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new CapabilityCommandError('workflow_param_invalid', `${name} 必须是 ${min}–${max} 的整数`)
  return number
}

function argsJsonOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new CapabilityCommandError('workflow_args_invalid', `--args 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const json = JSON.stringify(parsed)
  if (json === undefined) return undefined
  if (json.length > MAX_ARGS_CHARS) throw new CapabilityCommandError('workflow_args_too_large', `args 超过 ${MAX_ARGS_CHARS} 字符`)
  return json
}

function preview(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null'
  return text.length > SUMMARY_RESULT_CHARS ? { text: `${text.slice(0, SUMMARY_RESULT_CHARS)}…`, truncated: true } : { text, truncated: false }
}

export class WorkflowService {
  private readonly records = new Map<string, WorkflowRecord>()
  private readonly runners = new Map<string, WorkflowRunner>()
  private readonly waiters = new Map<string, Set<FinishWaiter>>()
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly persistQueue = new Map<string, Promise<void>>()
  private loading: Promise<void> | null = null
  readonly slots: SlotGate
  private readonly notifier: WorkflowNotifier<WorkflowRecord>
  private readonly now: () => number

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.now = deps.now ?? Date.now
    this.slots = new SlotGate({ capacity: WORKFLOW_LIMITS.globalSlots, running: () => deps.runningSubagents(), pollMs: deps.slotPollMs })
    this.notifier = createWorkflowNotifier<WorkflowRecord>({
      keyOf: (record) => record.view.id,
      find: (record) => deps.findTarget(this.viewOf(record)),
      build: (record) => this.noticeText(record),
      delivered: (record) => {
        record.notified = true
        void this.persist(record)
      },
      pollMs: deps.noticePollMs
    })
  }

  owns(run: Pick<SubagentRun, 'parentMessageId'>): boolean {
    return workflowIdOfAnchor(run.parentMessageId) !== null
  }

  onSubagentChange(): void {
    this.slots.notify()
  }

  onSubagentFinished(run: SubagentRun): void {
    this.slots.notify()
    const waiters = this.waiters.get(run.id)
    if (!waiters) return
    for (const waiter of [...waiters]) {
      if ((run.endedAt ?? Number.POSITIVE_INFINITY) > waiter.after) waiter.resolve(run)
    }
  }

  retryNotices(): void {
    this.notifier.retry()
  }

  adoptSessions(statuses: Array<{ runId: string; generation: number; sessionId?: string }>): void {
    for (const status of statuses) {
      const sessionId = status.sessionId
      if (!sessionId || sessionId.startsWith('pending:')) continue
      for (const record of this.records.values()) {
        if (record.context.parentRunId !== status.runId || record.context.parentGeneration !== status.generation) continue
        if (record.context.parentSessionId !== `pending:${status.runId}`) continue
        record.context.parentSessionId = sessionId
        record.view.sessionId = sessionId
        void this.persist(record)
        this.schedulePush(record)
      }
    }
  }

  waitFinished(id: string, after: number, signal: AbortSignal): Promise<SubagentRun | null> {
    if (signal.aborted) return Promise.resolve(null)
    return new Promise((resolveWait) => {
      let seen = 0
      let settled = false
      const set = this.waiters.get(id) ?? new Set<FinishWaiter>()
      this.waiters.set(id, set)
      const timer = setInterval(() => {
        void this.deps.getSubagent(id).then((run) => {
          if (settled) return
          if (run && TERMINAL.has(run.status) && (run.endedAt ?? 0) > after) {
            seen += 1
            if (seen >= 2) waiter.resolve(run)
          } else seen = 0
        }).catch(() => undefined)
      }, this.deps.waitPollMs ?? 3000)
      const waiter: FinishWaiter = {
        after,
        resolve: (run) => {
          if (settled) return
          settled = true
          clearInterval(timer)
          set.delete(waiter)
          if (!set.size && this.waiters.get(id) === set) this.waiters.delete(id)
          resolveWait(run)
        }
      }
      set.add(waiter)
      signal.addEventListener('abort', () => waiter.resolve(null), { once: true })
    })
  }

  async list(): Promise<WorkflowRunView[]> {
    await this.ensureLoaded()
    return [...this.records.values()].map((record) => this.viewOf(record)).sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_LISTED)
  }

  async control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<{ ok: boolean; error?: string; run?: WorkflowRunView }> {
    await this.ensureLoaded()
    const record = this.records.get(id)
    if (!record) return { ok: false, error: pick('找不到这个工作流', 'Workflow not found') }
    try {
      if (action === 'pause') this.pause(record)
      else if (action === 'stop') await this.stop(record)
      else {
        const runner = this.runners.get(id)
        if (!runner || runner.done || !runner.paused) return { ok: false, error: pick('只能继续已暂停的工作流；停止或中断的运行由主会话用 yan workflow resume 续跑', 'Only a paused workflow can continue here; the main session relaunches stopped or interrupted runs with yan workflow resume') }
        this.unpause(record)
      }
      return { ok: true, run: this.viewOf(record) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async run(command: string, params: Record<string, unknown>, context: WorkflowContext): Promise<CapabilityCommandResult> {
    await this.ensureLoaded()
    if (command === 'workflow.run') return this.commandRun(params, context)
    if (command === 'workflow.list') return this.commandList(context)
    const id = normalizeWorkflowId(params.id)
    if (!id) throw new CapabilityCommandError('workflow_id_required', '这个动作需要合法的工作流 id（例如 wf-1a2b3c4d）')
    const record = this.records.get(id)
    if (!record || !this.ownedBy(record, context)) throw new CapabilityCommandError('workflow_not_found', `找不到当前会话的工作流：${id}`)
    if (command === 'workflow.get') return this.commandGet(record)
    if (command === 'workflow.pause') {
      this.pause(record)
      return this.actionSummary('pause', record)
    }
    if (command === 'workflow.stop') {
      await this.stop(record)
      return this.actionSummary('stop', record)
    }
    if (command === 'workflow.resume') return this.commandResume(record, params, context)
    throw new CapabilityCommandError('not_implemented', `命令已登记但尚未实现：${command}`)
  }

  private ownedBy(record: WorkflowRecord, context: WorkflowContext): boolean {
    const session = record.context.parentSessionId
    if (session && context.parentSessionId && session === context.parentSessionId) return true
    return !!record.context.parentRunId && record.context.parentRunId === context.parentRunId && (session?.startsWith('pending:') ?? true)
  }

  private dirOf(record: Pick<WorkflowRecord, 'context'>, id: string): string {
    return join(this.deps.root, sessionKey(record.context), id)
  }

  private async commandRun(params: Record<string, unknown>, context: WorkflowContext): Promise<CapabilityCommandResult> {
    const file = typeof params.file === 'string' ? params.file.trim() : ''
    if (!file) throw new CapabilityCommandError('workflow_file_required', 'workflow run 需要 --file <脚本.js>')
    const source = await this.readScript(file, context.cwd)
    const checked = checkWorkflowScript(source)
    if (!checked.ok) throw new CapabilityCommandError('workflow_script_invalid', checked.error)
    const argsJson = argsJsonOf(params.args)
    const concurrency = intParam(params.concurrency, 'concurrency', 1, WORKFLOW_LIMITS.maxConcurrency) ?? WORKFLOW_LIMITS.defaultConcurrency
    const id = `wf-${randomBytes(4).toString('hex')}`
    const recordContext: WorkflowContext = { ...context }
    const dir = this.dirOf({ context: recordContext }, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, SCRIPT_FILE), source, 'utf8')
    await writeFile(join(dir, JOURNAL_FILE), '', 'utf8')
    const record: WorkflowRecord = {
      context: recordContext,
      ...(argsJson !== undefined ? { argsJson } : {}),
      view: {
        id,
        ...(context.parentSessionId ? { sessionId: context.parentSessionId } : {}),
        ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
        ...(context.parentGeneration !== undefined ? { parentGeneration: context.parentGeneration } : {}),
        ...(context.parentMessageId ? { parentMessageId: context.parentMessageId } : {}),
        cwd: context.cwd,
        name: checked.meta.name,
        description: checked.meta.description,
        declaredPhases: checked.meta.phases ?? [],
        status: 'running',
        startedAt: this.now(),
        attempt: 1,
        concurrency,
        agents: [],
        logs: [],
        dir
      }
    }
    this.records.set(id, record)
    await this.persist(record)
    this.launch(record, checked.code, new Map())
    const view = this.viewOf(record)
    return {
      data: view,
      summary: {
        kind: 'workflow',
        action: 'run',
        id,
        name: view.name,
        status: view.status,
        phases: view.declaredPhases,
        concurrency,
        dir,
        note: '工作流在后台运行，结束时宿主会把最终答案作为通知发给你；不要 sleep 轮询，继续做不依赖它的事，或结束本轮'
      }
    }
  }

  private async readScript(file: string, cwd: string): Promise<string> {
    const path = isAbsolute(file) ? file : resolve(cwd, file)
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      throw new CapabilityCommandError('workflow_file_unreadable', `读不到脚本 ${path}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private launch(record: WorkflowRecord, code: string, previous: ReturnType<typeof readJournal>): void {
    const id = record.view.id
    const subagentContext = (): WorkflowContext => ({ ...record.context, parentMessageId: workflowAnchor(id) })
    const runner = new WorkflowRunner({
      workerPath: this.deps.workerPath,
      code,
      ...(record.argsJson !== undefined ? { argsJson: record.argsJson } : {}),
      journalFile: join(record.view.dir, JOURNAL_FILE),
      attempt: record.view.attempt,
      concurrency: record.view.concurrency,
      previous,
      slots: this.slots,
      now: this.now,
      host: {
        start: async (params) => {
          const out = await this.deps.subagentCommand('subagent.start', params, subagentContext())
          const run = out.data as Partial<SubagentRun> | undefined
          const started = typeof run?.id === 'string' ? run.id : typeof out.summary.id === 'string' ? out.summary.id : ''
          if (!started) throw new Error('子代理启动后没有返回 id')
          return started
        },
        send: async (subagentId, message) => {
          await this.deps.subagentCommand('subagent.send', { id: subagentId, message, mode: 'follow-up' }, subagentContext())
        },
        stop: async (subagentId) => {
          await this.deps.subagentCommand('subagent.stop', { id: subagentId }, subagentContext())
        },
        waitFinished: (subagentId, after, signal) => this.waitFinished(subagentId, after, signal)
      },
      onChange: () => this.schedulePush(record),
      onFinish: (outcome) => void this.finish(record, runner, outcome)
    })
    this.runners.set(id, runner)
    runner.start()
    this.schedulePush(record)
  }

  private async finish(record: WorkflowRecord, runner: WorkflowRunner, outcome: WorkflowOutcome): Promise<void> {
    if (this.runners.get(record.view.id) !== runner) return
    record.view.agents = runner.agents.filter(Boolean).map((agent) => ({ ...agent }))
    record.view.logs = [...runner.logs]
    record.view.status = outcome.status
    record.view.endedAt = this.now()
    if (outcome.status === 'failed') record.view.error = outcome.error
    else delete record.view.error
    let result: unknown
    if (outcome.status === 'done') {
      try {
        result = JSON.parse(outcome.json)
      } catch {
        result = null
      }
    }
    if (outcome.status !== 'stopped') {
      const payload = outcome.status === 'done' ? { ok: true, result, endedAt: record.view.endedAt } : { ok: false, error: outcome.error, endedAt: record.view.endedAt }
      try {
        await writeFile(join(record.view.dir, RESULT_FILE), JSON.stringify(payload, null, 2), 'utf8')
        record.view.hasResult = outcome.status === 'done'
      } catch (error) {
        console.warn('[workflow] 写最终结果失败', error)
      }
      record.notified = false
    }
    this.runners.delete(record.view.id)
    await this.persist(record)
    this.schedulePush(record, true)
    if (outcome.status !== 'stopped') this.notifier.notify(record)
  }

  private viewOf(record: WorkflowRecord): WorkflowRunView {
    const runner = this.runners.get(record.view.id)
    if (!runner || runner.done) return { ...record.view, agents: record.view.agents.map((agent) => ({ ...agent })), logs: [...record.view.logs] }
    const status: WorkflowStatus = runner.paused ? 'paused' : 'running'
    return { ...record.view, status, agents: runner.agents.filter(Boolean).map((agent) => ({ ...agent })), logs: [...runner.logs] }
  }

  private schedulePush(record: WorkflowRecord, now = false): void {
    const id = record.view.id
    const flush = (): void => {
      this.pushTimers.delete(id)
      const view = this.viewOf(record)
      if (isLiveWorkflow(view.status)) {
        record.view.agents = view.agents
        record.view.logs = view.logs
        record.view.status = view.status
        void this.persist(record)
      }
      try {
        this.deps.push(view)
      } catch (error) {
        console.warn('[workflow] 推送运行状态失败', error)
      }
    }
    const pending = this.pushTimers.get(id)
    if (now) {
      if (pending) clearTimeout(pending)
      flush()
      return
    }
    if (pending) return
    const timer = setTimeout(flush, this.deps.pushDelayMs ?? 150)
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
    this.pushTimers.set(id, timer)
  }

  private persist(record: WorkflowRecord): Promise<void> {
    const id = record.view.id
    const previous = this.persistQueue.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const file = join(record.view.dir, RECORD_FILE)
      const temp = `${file}.tmp`
      const body = JSON.stringify({ view: record.view, context: record.context, ...(record.argsJson !== undefined ? { argsJson: record.argsJson } : {}), ...(record.notified !== undefined ? { notified: record.notified } : {}) }, null, 2)
      await mkdir(record.view.dir, { recursive: true })
      await writeFile(temp, body, 'utf8')
      await rename(temp, file)
    }).catch((error: unknown) => console.warn('[workflow] 保存运行状态失败', error))
    this.persistQueue.set(id, next)
    void next.finally(() => {
      if (this.persistQueue.get(id) === next) this.persistQueue.delete(id)
    })
    return next
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loading) this.loading = this.load()
    return this.loading
  }

  private async load(): Promise<void> {
    let sessions: string[] = []
    try {
      sessions = await readdir(this.deps.root)
    } catch {
      return
    }
    for (const session of sessions) {
      let ids: string[] = []
      try {
        ids = await readdir(join(this.deps.root, session))
      } catch {
        continue
      }
      for (const id of ids) {
        if (!normalizeWorkflowId(id) || this.records.has(id)) continue
        const dir = join(this.deps.root, session, id)
        try {
          const raw = JSON.parse(await readFile(join(dir, RECORD_FILE), 'utf8')) as unknown
          if (!isRecord(raw) || raw.view.id !== id) continue
          raw.view.dir = dir
          if (isLiveWorkflow(raw.view.status) && !this.runners.has(id)) {
            raw.view.status = 'interrupted'
            raw.view.error = '应用退出时工作流还在运行；没有自动续跑，需要时用 yan workflow resume 续跑'
            raw.view.agents = raw.view.agents.map((agent) => (agent.status === 'running' || agent.status === 'queued' ? { ...agent, status: 'stopped' } : agent))
            this.records.set(id, raw)
            await this.persist(raw)
          } else this.records.set(id, raw)
          if (raw.notified === false && (raw.view.status === 'done' || raw.view.status === 'failed')) this.notifier.notify(raw)
        } catch {
        }
      }
    }
  }

  private pause(record: WorkflowRecord): void {
    const runner = this.runners.get(record.view.id)
    if (!runner || runner.done) throw new CapabilityCommandError('workflow_not_running', `工作流 ${record.view.id} 没有在运行（状态：${record.view.status}）`)
    runner.pause()
    this.schedulePush(record, true)
  }

  private unpause(record: WorkflowRecord): void {
    const runner = this.runners.get(record.view.id)
    if (!runner || runner.done) throw new CapabilityCommandError('workflow_not_running', `工作流 ${record.view.id} 没有在运行`)
    runner.resume()
    this.schedulePush(record, true)
  }

  private async stop(record: WorkflowRecord): Promise<void> {
    const runner = this.runners.get(record.view.id)
    if (runner && !runner.done) {
      await runner.stop()
      return
    }
    if (record.view.status === 'interrupted') {
      record.view.status = 'stopped'
      delete record.view.error
      await this.persist(record)
      this.schedulePush(record, true)
    }
  }

  private async commandResume(record: WorkflowRecord, params: Record<string, unknown>, context: WorkflowContext): Promise<CapabilityCommandResult> {
    const runner = this.runners.get(record.view.id)
    if (runner && !runner.done) {
      if (!runner.paused) throw new CapabilityCommandError('workflow_running', `工作流 ${record.view.id} 正在运行，不需要续跑`)
      this.unpause(record)
      return this.actionSummary('resume', record)
    }
    const stillRunning: string[] = []
    for (const agent of record.view.agents) {
      if (!agent.subagentId) continue
      const run = await this.deps.getSubagent(agent.subagentId).catch(() => undefined)
      if (run && (run.status === 'running' || run.status === 'starting') && workflowIdOfAnchor(run.parentMessageId) === record.view.id) stillRunning.push(agent.subagentId)
    }
    if (stillRunning.length) throw new CapabilityCommandError('workflow_agents_running', `上次运行的子代理还没退出（${stillRunning.slice(0, 5).join('、')}），等它们结束后再续跑`)
    const file = typeof params.file === 'string' ? params.file.trim() : ''
    const source = file ? await this.readScript(file, context.cwd) : await readFile(join(record.view.dir, SCRIPT_FILE), 'utf8').catch(() => '')
    if (!source) throw new CapabilityCommandError('workflow_script_missing', `运行目录里没有 ${SCRIPT_FILE}，不能续跑；改用 yan workflow run 重新开始`)
    const checked = checkWorkflowScript(source)
    if (!checked.ok) throw new CapabilityCommandError('workflow_script_invalid', checked.error)
    if (file) await writeFile(join(record.view.dir, SCRIPT_FILE), source, 'utf8')
    if (params.args !== undefined) {
      const argsJson = argsJsonOf(params.args)
      if (argsJson === undefined) delete record.argsJson
      else record.argsJson = argsJson
    }
    const concurrency = intParam(params.concurrency, 'concurrency', 1, WORKFLOW_LIMITS.maxConcurrency)
    let previous: ReturnType<typeof readJournal>
    try {
      previous = readJournal(await readFile(join(record.view.dir, JOURNAL_FILE), 'utf8'))
    } catch {
      previous = new Map()
    }
    record.view.name = checked.meta.name
    record.view.description = checked.meta.description
    record.view.declaredPhases = checked.meta.phases ?? []
    record.view.attempt += 1
    if (concurrency) record.view.concurrency = concurrency
    record.view.status = 'running'
    record.view.agents = []
    record.view.logs = []
    delete record.view.endedAt
    delete record.view.error
    delete record.notified
    await this.persist(record)
    this.launch(record, checked.code, previous)
    const reusable = [...previous.values()].filter((entry) => entry.status === 'done').length
    return {
      data: this.viewOf(record),
      summary: {
        kind: 'workflow',
        action: 'resume',
        id: record.view.id,
        status: 'running',
        attempt: record.view.attempt,
        savedResults: reusable,
        note: '已按运行记录续跑：序号和提示词都没变的已完成调用直接返回保存的结果，从第一个变化、失败或被停的调用起重跑；结束时宿主会通知你'
      }
    }
  }

  private commandList(context: WorkflowContext): CapabilityCommandResult {
    const views = [...this.records.values()].filter((record) => this.ownedBy(record, context)).map((record) => this.viewOf(record)).sort((a, b) => a.startedAt - b.startedAt)
    return {
      data: views,
      summary: {
        kind: 'workflow',
        action: 'list',
        count: views.length,
        runs: views.map((view) => {
          const totals = workflowTotals(view)
          return { id: view.id, name: view.name, status: view.status, agents: totals.total, done: totals.done, failed: totals.failed }
        })
      }
    }
  }

  private async readResult(record: WorkflowRecord): Promise<{ ok?: boolean; result?: unknown; error?: string } | null> {
    try {
      return JSON.parse(await readFile(join(record.view.dir, RESULT_FILE), 'utf8')) as { ok?: boolean; result?: unknown; error?: string }
    } catch {
      return null
    }
  }

  private async commandGet(record: WorkflowRecord): Promise<CapabilityCommandResult> {
    const view = this.viewOf(record)
    const totals = workflowTotals(view)
    const saved = view.status === 'done' || view.status === 'failed' ? await this.readResult(record) : null
    const shown = saved?.ok ? preview(saved.result) : null
    return {
      data: { ...view, ...(saved?.ok ? { result: saved.result } : {}) },
      summary: {
        kind: 'workflow',
        action: 'get',
        id: view.id,
        name: view.name,
        status: view.status,
        attempt: view.attempt,
        agents: totals.total,
        done: totals.done,
        running: totals.running,
        queued: totals.queued,
        failed: totals.failed,
        phases: workflowPhaseStats(view).map((phase) => ({ title: phase.title || '—', done: phase.done, total: phase.total })),
        ...(view.logs.length ? { latestLog: view.logs[view.logs.length - 1] } : {}),
        ...(view.error ? { error: view.error } : {}),
        dir: view.dir,
        ...(shown ? { result: shown.text, ...(shown.truncated ? { resultTruncated: true, resultFull: `全文在 resultFile 的 result；也可用 yan workflow get --id ${view.id} --final 直接输出` } : {}) } : {})
      }
    }
  }

  private actionSummary(action: string, record: WorkflowRecord): CapabilityCommandResult {
    const view = this.viewOf(record)
    return { data: view, summary: { kind: 'workflow', action, id: view.id, status: view.status } }
  }

  private async noticeText(record: WorkflowRecord): Promise<string> {
    const view = this.viewOf(record)
    const saved = view.status === 'done' ? await this.readResult(record) : null
    const worktrees: WorkflowWorktree[] = []
    const seen = new Set<string>()
    for (const agent of view.agents) {
      if (!agent.subagentId || seen.has(agent.subagentId)) continue
      seen.add(agent.subagentId)
      const run = await this.deps.getSubagent(agent.subagentId).catch(() => undefined)
      if (run?.isolation === 'worktree') worktrees.push(run)
    }
    return buildWorkflowNotice({ run: view, result: saved?.result, worktrees })
  }
}
