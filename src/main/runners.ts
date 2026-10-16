import type { AgentController } from './agent'
import type { RunnerStatus, RuntimeEnvelope, SessionScope } from '../shared/ipc'
import type { McpNativeBootWitness } from './mcp/app-native-witness'
import type { McpServerStatus } from '../shared/mcp'
import { executionBusy, runEnvelope, runStatus } from '../core/run-state'
import { canReclaimIdle, IDLE_RECLAIM_ENABLED, IDLE_RECLAIM_SCAN_MS } from './runner-reclaim'
import {
  admissionClaimedBy,
  guardSameCwdExecute,
  SAME_CWD_ADMISSION_ERROR,
  SAME_CWD_BUSY_ERROR,
  type ExecuteAdmissionClaim,
  type ExecuteAdmissionPort,
  type ExecuteGuardResult
} from './session-send-guard'

export const RUNNER_LIMIT = 3

let lastGeneration = 0
function nextGeneration(): number {
  lastGeneration += 1
  return lastGeneration
}

function canonicalCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function readNativeWitness(agent: AgentController): McpNativeBootWitness | null {
  const maybe = (agent as AgentController & { nativeBootWitness?: () => McpNativeBootWitness | null }).nativeBootWitness
  if (typeof maybe !== 'function') return null
  try {
    return maybe.call(agent) ?? null
  } catch {
    return null
  }
}

function readLegacyMcpServices(agent: AgentController): Array<{ serverId: string; status: McpServerStatus }> | null {
  const maybe = (agent as AgentController & {
    getLegacyMcpHolderSnapshot?: () => { services?: unknown }
  }).getLegacyMcpHolderSnapshot
  if (typeof maybe !== 'function') return null
  try {
    const snapshot = maybe.call(agent)
    if (!snapshot || !Array.isArray(snapshot.services)) return null
    return snapshot.services.filter(
      (entry): entry is { serverId: string; status: McpServerStatus } =>
        Boolean(entry && typeof (entry as { serverId?: unknown }).serverId === 'string')
    )
  } catch {
    return null
  }
}

interface Runner {
  id: string
  agent: AgentController
  cwd: string
  projectId?: string
  generation: number
  createdAt: number
  lastActiveAt: number
  hidden?: boolean
}

export interface McpHolderSnapshot {
  runnerId: string
  generation: number
  projectId: string | null
  cwd: string
  processRunning: boolean
  conn: 'starting' | 'ready' | 'exited' | 'error'
  busy: boolean
  nativeWitness: McpNativeBootWitness | null
  legacyMcpServices: Array<{ serverId: string; status: McpServerStatus }> | null
}

export interface RunnerRunOrigin {
  kind: 'scheduled'
  scopeId: string
}

export interface SelectTarget {
  sessionFile?: string
  sessionId?: string
  projectId?: string
  scope?: SessionScope
  activate?: boolean
  preview?: boolean
  hidden?: boolean
  origin?: RunnerRunOrigin
  cwd: string
}

export interface SelectResult {
  ok: boolean
  id?: string
  runId?: string
  sessionId?: string
  generation?: number
  via?: 'hit' | 'reuse' | 'new'
  deferred?: boolean
  error?: string
}

export class RunnerRegistry {
  private runners = new Map<string, Runner>()
  private activeId: string | null = null
  private seq = 0
  private selectTail: Promise<void> = Promise.resolve()
  private restartOperations = new Map<string, Promise<SelectResult>>()
  private reclaimOperation?: Promise<string | null>
  private reclaimTimer?: ReturnType<typeof setInterval>
  private disposed = false
  private admissionCounter = 0
  private admissions = new Map<string, ExecuteAdmissionClaim>()

  private pruneAdmissions(): void {
    for (const [key, claim] of this.admissions) {
      const runner = this.runners.get(claim.runId)
      if (!runner || runner.generation !== claim.generation || canonicalCwd(runner.cwd) !== key) {
        this.admissions.delete(key)
      }
    }
  }

  admitExecute(id: string): { ok: true; token: number } | { ok: false; error: string } {
    const runner = this.runners.get(id)
    if (!runner) return { ok: false, error: '运行实例不存在' }
    this.pruneAdmissions()
    const key = canonicalCwd(runner.cwd)
    const existing = this.admissions.get(key)
    if (existing) {
      if (admissionClaimedBy(existing, id, runner.generation)) return { ok: true, token: existing.token }
      return { ok: false, error: SAME_CWD_ADMISSION_ERROR }
    }
    if (this.hasBusyCwd(runner.cwd, id)) return { ok: false, error: SAME_CWD_BUSY_ERROR }
    const token = ++this.admissionCounter
    this.admissions.set(key, { token, runId: id, generation: runner.generation, cwd: runner.cwd })
    return { ok: true, token }
  }

  confirmExecute(id: string, token: number): boolean {
    const runner = this.runners.get(id)
    if (!runner) return false
    const claim = this.admissions.get(canonicalCwd(runner.cwd))
    if (claim && claim.token === token && admissionClaimedBy(claim, id, runner.generation)) return true
    return this.busy(runner) && this.hasBusyCwd(runner.cwd, id) === false
  }

  releaseExecute(id: string, token: number): void {
    for (const [key, claim] of this.admissions) {
      if (claim.token === token && claim.runId === id) {
        this.admissions.delete(key)
        return
      }
    }
  }

  executionPort(id: string): ExecuteAdmissionPort {
    return {
      claim: () => this.admitExecute(id),
      confirm: (token) => this.confirmExecute(id, token),
      release: (token) => this.releaseExecute(id, token)
    }
  }

  resolveExpectedRunner(expected: { sessionId?: string; runId?: string; generation?: number } | null | undefined): string | null {
    if (!expected) return null
    let runner = expected.runId ? this.runners.get(expected.runId) : undefined
    if (!runner && expected.sessionId && !expected.sessionId.startsWith('pending:')) {
      runner = this.findBySessionId(expected.sessionId)
    }
    if (!runner && expected.sessionId?.startsWith('pending:')) {
      runner = this.runners.get(expected.sessionId.slice('pending:'.length))
    }
    if (!runner) return null
    if (expected.generation !== undefined && runner.generation !== expected.generation) return null
    return runner.id
  }

  constructor(
    private opts: {
      limit?: number
      now?: () => number
      isSessionVisible?: (state: ReturnType<AgentController['getState']>) => boolean
      isParentProtected?: (sessionId: string | undefined, runId: string) => boolean
      onReclaimed?: (entry: { id: string; sessionId?: string; idleMs: number; remaining: number }) => void
      createAgent: (id: string, cwd: string, generation?: number) => AgentController
      prepareNewSession?: (agent: AgentController) => Promise<{ ok: boolean; error?: string }>
      onChanged?: () => void
      onRunnerOrigin?: (info: {
        runnerId: string
        generation: number
        sessionId?: string
        origin?: RunnerRunOrigin
      }) => void
      resolveCwdConflict?: (target: SelectTarget) => Promise<{ cwd: string } | { reason: string } | null>
      isolationOf?: (cwd: string) => { state: 'waiting' | 'blocked'; branch: string } | undefined
    }
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  noteActivity(id: string): void {
    const runner = this.runners.get(id)
    if (runner) runner.lastActiveAt = this.now()
  }

  noteVisibleActivity(): void {
    for (const runner of this.runners.values()) {
      if (this.opts.isSessionVisible?.(runner.agent.getState()) ?? true) this.noteActivity(runner.id)
    }
  }

  private activateRunner(id: string): void {
    if (this.activeId && this.activeId !== id) this.noteActivity(this.activeId)
    this.activeId = id
  }

  startIdleReclaim(): void {
    if (!IDLE_RECLAIM_ENABLED || this.disposed || this.reclaimTimer) return
    this.reclaimTimer = setInterval(() => {
      void this.reclaimIdle().catch((error) => console.error('[runner-reclaim]', error))
    }, IDLE_RECLAIM_SCAN_MS)
    this.reclaimTimer.unref?.()
  }

  reclaimIdle(): Promise<string | null> {
    if (this.reclaimOperation) return this.reclaimOperation
    const operation = this.serialize(async () => {
      if (!IDLE_RECLAIM_ENABLED || this.disposed) return null
      const now = this.now()
      for (const runner of [...this.runners.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
        const state = runner.agent.getState()
        const queue = runner.agent.queueSnapshot()
        const facts = {
          active: runner.id === this.activeId,
          hidden: runner.hidden === true,
          busy: this.busy(runner),
          busyCwd: this.hasBusyCwd(runner.cwd, runner.id),
          ready: runner.agent.getConn().state === 'ready',
          saved: !!state?.sessionFile,
          queued: queue.steering.length > 0 || queue.followUp.length > 0,
          visible: this.opts.isSessionVisible?.(state) ?? true,
          parentProtected: this.opts.isParentProtected?.(state?.sessionId, runner.id) ?? false,
          restarting: this.restartOperations.has(runner.id),
          lastActiveAt: runner.lastActiveAt
        }
        if (facts.active || facts.busy || facts.busyCwd || facts.queued || facts.visible || facts.parentProtected || facts.restarting || !facts.ready) {
          runner.lastActiveAt = now
        }
        if (!canReclaimIdle(facts, now)) continue
        const idleMs = now - runner.lastActiveAt
        if (await this.stopOne(runner.id)) {
          this.opts.onReclaimed?.({ id: runner.id, sessionId: state?.sessionId, idleMs, remaining: this.size })
          return runner.id
        }
      }
      return null
    })
    this.reclaimOperation = operation
    void operation.finally(() => {
      if (this.reclaimOperation === operation) this.reclaimOperation = undefined
    }).catch(() => undefined)
    return operation
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.selectTail.then(work, work)
    this.selectTail = next.then(() => undefined, () => undefined)
    return next
  }

  get limit(): number {
    return this.opts.limit ?? RUNNER_LIMIT
  }

  get activeRunnerId(): string | null {
    return this.activeId
  }

  active(): AgentController | null {
    if (!this.activeId) return null
    return this.runners.get(this.activeId)?.agent ?? null
  }

  activeRunner(): { id: string; cwd: string } | null {
    if (!this.activeId) return null
    const r = this.runners.get(this.activeId)
    return r ? { id: r.id, cwd: r.cwd } : null
  }

  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    for (const runner of this.runners.values()) {
      const result = runner.agent.extendHostUi(id, extraMs)
      if (result.ok) return result
    }
    return { ok: false, error: 'question_not_pending' }
  }

  respondUi(res: Parameters<AgentController['respondUi']>[0]): void {
    for (const runner of this.runners.values()) {
      if (runner.agent.pendingUiRequests().some((item) => item.id === res.id)) {
        runner.agent.respondUi(res)
        return
      }
    }
    this.active()?.respondUi(res)
  }

  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    for (const runner of this.runners.values()) {
      const result = runner.agent.startHostUiTimer(id)
      if (result.ok) return result
    }
    return { ok: false, error: 'question_not_pending' }
  }

  agentOf(id: string): AgentController | null {
    return this.runners.get(id)?.agent ?? null
  }

  async reloadMcpServers(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.agent.reloadMcpServers()))
  }

  agentForSession(sessionId: string): AgentController | null {
    return this.findBySessionId(sessionId)?.agent ?? null
  }

  runtimeOf(id: string): RuntimeEnvelope | null {
    const runner = this.runners.get(id)
    if (!runner) return null
    return runEnvelope(runner, runner.agent.getState())
  }

  private busy(runner: Runner): boolean {
    return executionBusy(
      runner.agent.getState(),
      () => runner.agent.hasRunningBash(),
      () => runner.agent.getPendingUiCount()
    )
  }

  private findBySessionFile(sessionFile: string): Runner | undefined {
    for (const r of this.runners.values()) {
      if (r.agent.getState()?.sessionFile === sessionFile) return r
    }
    return undefined
  }

  private findBySessionId(sessionId: string): Runner | undefined {
    for (const r of this.runners.values()) {
      if (r.agent.getState()?.sessionId === sessionId) return r
    }
    return undefined
  }

  private result(runner: Runner, via: SelectResult['via']): SelectResult {
    return {
      ok: true,
      id: runner.id,
      runId: runner.id,
      sessionId: runner.agent.getState()?.sessionId,
      generation: runner.generation,
      via
    }
  }

  private notifyRunnerOrigin(
    runner: Runner,
    origin: RunnerRunOrigin | undefined,
    facts: { sessionId?: string; generation?: number } = {}
  ): void {
    const sessionId = facts.sessionId ?? runner.agent.getState()?.sessionId
    try {
      this.opts.onRunnerOrigin?.({
        runnerId: runner.id,
        generation: facts.generation ?? runner.generation,
        ...(sessionId ? { sessionId } : {}),
        origin
      })
    } catch {
    }
  }

  async select(target: SelectTarget): Promise<SelectResult> {
    return this.serialize(() => this.selectNow(target))
  }

  private async selectNow(target: SelectTarget): Promise<SelectResult> {
    if (target.sessionId || target.sessionFile) {
      const hit = (target.sessionId && this.findBySessionId(target.sessionId)) ||
        (target.sessionFile ? this.findBySessionFile(target.sessionFile) : undefined)
      if (hit) {
        hit.lastActiveAt = this.now()
        if (target.activate !== false) this.activateRunner(hit.id)
        this.opts.onChanged?.()
        this.notifyRunnerOrigin(hit, target.origin)
        return this.result(hit, 'hit')
      }
    }

    const conflict = [...this.runners.values()].find(
      (runner) => canonicalCwd(runner.cwd) === canonicalCwd(target.cwd) && this.busy(runner)
    )
    if (conflict) {
      if (target.preview) return { ok: true, deferred: true, sessionId: target.sessionId }
      const escalated = await this.opts.resolveCwdConflict?.(target)
      if (escalated && 'cwd' in escalated && canonicalCwd(escalated.cwd) !== canonicalCwd(target.cwd)) {
        target = { ...target, cwd: escalated.cwd }
        if (this.hasBusyCwd(target.cwd)) {
          return {
            ok: false,
            error:
              '隔离目标目录里还有会话正在运行，无法在这里再开一个：两个同时写文件的回合会互相覆盖。' +
              '请等它跑完或停止它。'
          }
        }
      } else {
        const reason = escalated && 'reason' in escalated && escalated.reason ? `（${escalated.reason}）` : ''
        return {
          ok: false,
          error:
            `同一工作目录还有会话正在运行，无法在这里再开一个：两个同时写文件的回合会互相覆盖。${reason}` +
            '请等它跑完或停止它；Git 仓库会自动建隔离工作树，非 Git 目录没有安全的隔离基线。'
        }
      }
    }

    const idle = [...this.runners.values()]
      .filter((runner) => !target.hidden && !runner.hidden && !this.busy(runner) && (target.activate !== false || runner.id !== this.activeId))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]

    if (idle) {
      if (canonicalCwd(idle.cwd) !== canonicalCwd(target.cwd)) {
        const previous = idle.agent
        const generation = nextGeneration()
        let replacement: AgentController | undefined
        let failure: string | undefined
        try {
          replacement = this.opts.createAgent(idle.id, target.cwd, generation)
          replacement.setRunnerGeneration(generation)
          const started = await replacement.start()
          if (!started.ok) {
            failure = started.error ?? '替代运行实例启动失败'
          } else {
            let prepared = target.sessionFile
              ? await replacement.switchSession(target.sessionFile)
              : await replacement.newSession()
            if (prepared.ok) {
              this.notifyRunnerOrigin(idle, target.origin, {
                sessionId: replacement.getState()?.sessionId,
                generation
              })
            }
            if (prepared.ok && !target.sessionFile && this.opts.prepareNewSession) {
              prepared = await this.opts.prepareNewSession(replacement)
            }
            if (!prepared.ok) {
              this.notifyRunnerOrigin(idle, undefined, { sessionId: replacement.getState()?.sessionId, generation })
              failure = prepared.error ?? '替代运行实例准备会话失败'
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (failure !== undefined) {
          try {
            await replacement?.stop()
          } catch {
          }
          return { ok: false, error: failure }
        }

        idle.agent = replacement!
        idle.cwd = target.cwd
        idle.generation = generation
        idle.projectId = target.projectId
        idle.lastActiveAt = this.now()
        if (target.activate !== false) this.activateRunner(idle.id)
        try {
          await previous.stop()
        } catch {
        }
        this.opts.onChanged?.()
        this.notifyRunnerOrigin(idle, target.origin)
        return this.result(idle, 'reuse')
      }

      const oldProjectId = idle.projectId
      const oldSessionFile = idle.agent.getState()?.sessionFile
      const oldQueue = idle.agent.queueSnapshot?.() ?? { steering: [], followUp: [] }
      idle.generation = nextGeneration()
      idle.agent.setRunnerGeneration(idle.generation)
      idle.projectId = target.projectId
      this.opts.onChanged?.()

      let res = target.sessionFile
        ? await idle.agent.switchSession(target.sessionFile)
        : await idle.agent.newSession()
      if (res.ok) {
        this.notifyRunnerOrigin(idle, target.origin, { sessionId: idle.agent.getState()?.sessionId })
      }
      if (res.ok && !target.sessionFile && this.opts.prepareNewSession) res = await this.opts.prepareNewSession(idle.agent)
      if (!res.ok) {
        this.notifyRunnerOrigin(idle, undefined, { sessionId: idle.agent.getState()?.sessionId })
        const currentFile = idle.agent.getState()?.sessionFile
        if (!target.sessionFile && oldSessionFile && currentFile !== oldSessionFile) {
          try { await idle.agent.switchSession(oldSessionFile) } catch { }
        }
        if ((oldQueue.steering.length || oldQueue.followUp.length) && typeof idle.agent.restoreQueueSnapshot === 'function') {
          try { await idle.agent.restoreQueueSnapshot(oldQueue) } catch { }
        }
        idle.projectId = oldProjectId
        this.opts.onChanged?.()
        return { ok: false, error: res.error }
      }
      idle.cwd = target.cwd
      idle.lastActiveAt = this.now()
      if (target.activate !== false) this.activateRunner(idle.id)
      this.opts.onChanged?.()
      this.notifyRunnerOrigin(idle, target.origin)
      return this.result(idle, 'reuse')
    }

    if (this.runners.size >= this.limit) {
      return {
        ok: false,
        error:
          `同时运行的会话已达上限（${this.limit} 个）。` +
          '先等其中一个跑完，或停止它，再切换 —— 不会为了腾位置停掉正在跑的会话。'
      }
    }

    const id = `r${++this.seq}`
    const generation = nextGeneration()
    const agent = this.opts.createAgent(id, target.cwd, generation)
    const runner: Runner = {
      id,
      agent,
      cwd: target.cwd,
      projectId: target.projectId,
      generation,
      createdAt: this.now(),
      hidden: target.hidden,
      lastActiveAt: this.now()
    }
    const previousActive = this.activeId
    this.runners.set(id, runner)
    if (target.activate !== false) this.activateRunner(id)

    let failure: string | undefined
    try {
      const started = await agent.start()
      if (!started.ok) {
        failure = started.error ?? '实例启动失败'
      } else if (target.sessionFile) {
        const sw = await agent.switchSession(target.sessionFile)
        if (!sw.ok) failure = sw.error ?? '切换会话失败'
        else this.notifyRunnerOrigin(runner, target.origin, { sessionId: agent.getState()?.sessionId })
      } else {
        this.notifyRunnerOrigin(runner, target.origin, { sessionId: agent.getState()?.sessionId })
        if (this.opts.prepareNewSession) {
          const prepared = await this.opts.prepareNewSession(agent)
          if (!prepared.ok) failure = prepared.error ?? '新会话模型初始化失败'
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== undefined) {
      await this.discardNewRunner(id, runner, previousActive)
      return { ok: false, error: failure }
    }
    this.opts.onChanged?.()
    this.notifyRunnerOrigin(runner, target.origin)
    return this.result(runner, 'new')
  }

  private async discardNewRunner(id: string, runner: Runner, previousActive: string | null): Promise<void> {
    this.notifyRunnerOrigin(runner, undefined, { sessionId: runner.agent.getState()?.sessionId })
    this.runners.delete(id)
    this.activeId = previousActive
    try {
      await runner.agent.stop()
    } catch {
    }
    this.opts.onChanged?.()
  }

  async startPrimary(cwd: string, sessionFile?: string, projectId?: string): Promise<SelectResult> {
    const existing = this.active()
    if (existing) {
      const id = this.activeId
      const runner = id ? this.runners.get(id) : undefined
      return runner ? this.result(runner, 'hit') : { ok: true, id: id ?? undefined, via: 'hit' }
    }
    return this.select({ cwd, sessionFile, projectId, scope: 'project' })
  }

  restartOne(id: string): Promise<SelectResult> {
    const current = this.restartOperations.get(id)
    if (current) return current
    const operation = this.serialize(() => this.restartOneNow(id))
    this.restartOperations.set(id, operation)
    void operation.finally(() => {
      if (this.restartOperations.get(id) === operation) this.restartOperations.delete(id)
    }).catch(() => undefined)
    return operation
  }

  private async restartOneNow(id: string): Promise<SelectResult> {
    const runner = this.runners.get(id)
    if (!runner) return { ok: false, error: `运行实例不存在：${id}` }
    if (this.busy(runner)) return { ok: false, error: '目标运行实例仍忙，拒绝重载' }
    if (this.hasBusyCwd(runner.cwd, id)) {
      return { ok: false, error: '同一工作目录还有其它运行实例在工作，拒绝重载' }
    }
    const sessionFile = runner.agent.getState()?.sessionFile
    if (!sessionFile) return { ok: false, error: '目标会话尚无已保存的会话文件，无法安全重载' }

    const previous = runner.agent
    const previousGeneration = runner.generation
    const queue = previous.queueSnapshot()
    const generation = nextGeneration()
    const replacement = this.opts.createAgent(runner.id, runner.cwd, generation)
    runner.agent = replacement
    runner.generation = generation
    this.opts.onChanged?.()

    let failure: string | undefined
    try {
      const started = await replacement.start()
      if (!started.ok) failure = started.error ?? '替代运行实例启动失败'
      if (!failure) {
        const switched = await replacement.switchSession(sessionFile)
        if (!switched.ok) failure = switched.error ?? '替代运行实例载入原会话失败'
      }
      if (!failure) {
        const restored = await replacement.restoreQueueSnapshot(queue)
        if (!restored.ok) failure = restored.error ?? '替代运行实例恢复排队消息失败'
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (failure) {
      runner.agent = previous
      runner.generation = previousGeneration
      try {
        await replacement.stop()
      } catch {
      }
      this.opts.onChanged?.()
      return { ok: false, error: failure }
    }

    try {
      await previous.stop()
    } catch {
    }
    runner.lastActiveAt = this.now()
    this.opts.onChanged?.()
    return this.result(runner, 'reuse')
  }

  idOf(agent: AgentController): string | null {
    for (const r of this.runners.values()) if (r.agent === agent) return r.id
    return null
  }

  async stopOne(id: string, preserveSelection = false): Promise<boolean> {
    const r = this.runners.get(id)
    if (!r) return false
    this.runners.delete(id)
    this.pruneAdmissions()
    if (this.activeId === id && !preserveSelection) this.activeId = null
    try {
      await r.agent.stop()
    } catch {
    }
    this.opts.onChanged?.()
    return true
  }

  async stopBySessionFile(sessionFile: string): Promise<boolean> {
    const hit = this.findBySessionFile(sessionFile)
    if (!hit) return false
    return this.stopOne(hit.id)
  }

  async stopByCwd(cwd: string): Promise<number> {
    const normalized = canonicalCwd(cwd)
    const ids = [...this.runners.values()]
      .filter((r) => canonicalCwd(r.cwd) === normalized)
      .map((r) => r.id)
    for (const id of ids) await this.stopOne(id)
    return ids.length
  }

  async stopAll(): Promise<void> {
    this.disposed = true
    if (this.reclaimTimer) clearInterval(this.reclaimTimer)
    this.reclaimTimer = undefined
    const all = [...this.runners.values()]
    this.runners.clear()
    this.admissions.clear()
    this.activeId = null
    for (const r of all) {
      try {
        await r.agent.stop()
      } catch {
      }
    }
    this.opts.onChanged?.()
  }

  hasBusy(): boolean {
    return [...this.runners.values()].some((r) => this.busy(r))
  }

  hasBusyCwd(cwd: string, exceptRunId?: string): boolean {
    const key = canonicalCwd(cwd)
    return [...this.runners.values()].some(
      (runner) => runner.id !== exceptRunId && canonicalCwd(runner.cwd) === key && this.busy(runner)
    )
  }

  guardExecute(id: string): ExecuteGuardResult {
    const runner = this.runners.get(id)
    if (!runner) return { ok: true }
    return guardSameCwdExecute(
      { runnerId: runner.id, cwd: runner.cwd, selfBusy: this.busy(runner) },
      (cwd, exceptRunId) => this.hasBusyCwd(cwd, exceptRunId)
    )
  }

  activationSnapshot(target: {
    runnerId: string
    cwd: string
    sessionFile: string
    projectId: string
  }): {
    id: string
    generation: number
    cwd: string
    sessionFile: string | null
    projectId: string | null
    ready: boolean
    busy: boolean
  } | null {
    const expectedCwd = canonicalCwd(target.cwd)
    const expectedSession = canonicalCwd(target.sessionFile)
    const matches = [...this.runners.values()].filter((runner) => {
      const state = runner.agent.getState()
      const projectId = runner.agent.capabilityProjectId ?? runner.projectId ?? null
      return canonicalCwd(runner.cwd) === expectedCwd &&
        canonicalCwd(state?.sessionFile ?? '') === expectedSession &&
        projectId === target.projectId
    })
    const runner = matches.find((item) => item.id === target.runnerId) ?? matches[0]
    if (!runner) return null
    const state = runner.agent.getState()
    return {
      id: runner.id,
      generation: runner.generation,
      cwd: runner.cwd,
      sessionFile: state?.sessionFile ?? null,
      projectId: runner.agent.capabilityProjectId ?? runner.projectId ?? null,
      ready: runner.agent.getConn().state === 'ready',
      busy: this.busy(runner)
    }
  }

  publishReplacement(sourceId: string, destinationId: string): boolean {
    const runner = this.runners.get(destinationId)
    if (!runner) return false
    runner.hidden = false
    const activate = this.activeId === sourceId
    runner.lastActiveAt = this.now()
    if (activate) this.activateRunner(destinationId)
    return activate
  }

  statuses(): RunnerStatus[] {
    return [...this.runners.values()].filter((r) => !r.hidden).map((r) => {
      const st = r.agent.getState()
      const conn = r.agent.getConn().state
      const isolation = this.opts.isolationOf?.(r.cwd)
      return runStatus({
        id: r.id,
        projectId: r.projectId,
        generation: r.generation,
        cwd: r.cwd,
        state: st,
        pendingUiCount: r.agent.getPendingUiCount(),
        conn,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
        isActive: r.id === this.activeId,
        isolation
      })
    })
  }

  mcpHolderSnapshots(): McpHolderSnapshot[] {
    return [...this.runners.values()].map((runner) => ({
      runnerId: runner.id,
      generation: runner.generation,
      projectId: runner.agent.capabilityProjectId ?? runner.projectId ?? null,
      cwd: runner.cwd,
      processRunning: runner.agent.running === true,
      conn: runner.agent.getConn().state,
      busy: this.busy(runner),
      nativeWitness: readNativeWitness(runner.agent),
      legacyMcpServices: readLegacyMcpServices(runner.agent)
    }))
  }

  mcpRuntimeEpoch(): string {
    return this.mcpHolderSnapshots()
      .map(
        (snapshot) =>
          `${snapshot.runnerId}#${snapshot.generation}#${snapshot.projectId ?? '-'}#${snapshot.conn}#${
            snapshot.processRunning ? 1 : 0
          }`
      )
      .join('|')
  }

  get size(): number {
    return this.runners.size
  }
}
