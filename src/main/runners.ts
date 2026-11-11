import { pick } from '../shared/ui-lang'
import type { AgentController } from './agent'
import type { RunnerStatus, RuntimeEnvelope, SessionScope } from '../shared/ipc'
import type { UiAnswerResult } from './ui-requests'
import type { McpNativeBootWitness } from './mcp/app-native-witness'
import type { McpServerStatus } from '../shared/mcp'
import { executionBusy, runEnvelope, runStatus } from '../core/run-state'
import { canReclaimIdle, IDLE_RECLAIM_SCAN_MS } from './runner-reclaim'
import {
  admissionClaimedBy,
  guardSameCwdExecute,
  sameCwdAdmissionError,
  sameCwdBusyError,
  type ExecuteAdmissionClaim,
  type ExecuteAdmissionPort,
  type ExecuteGuardResult
} from './session-send-guard'
import { workspacePathsOverlap } from './workspace-mutation'

export const RUNNER_LIMIT = 3

let lastGeneration = 0
function nextGeneration(): number {
  lastGeneration += 1
  return lastGeneration
}

function canonicalCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function agentAlive(agent: AgentController): boolean {
  const state = agent.getConn().state
  return state !== 'exited' && state !== 'error'
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

interface StoppingRunner {
  id: string
  cwd: string
  sessionId?: string
  sessionFile?: string
  done: Promise<void>
  finish: () => void
}

const STOP_WAIT_MS = 20_000

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

export interface SelectTarget {
  sessionFile?: string
  sessionId?: string
  projectId?: string
  scope?: SessionScope
  activate?: boolean
  preview?: boolean
  hidden?: boolean
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
  deferredReason?: 'cwd-busy' | 'limit'
  error?: string
}

export class RunnerRegistry {
  private runners = new Map<string, Runner>()
  private stopping = new Set<StoppingRunner>()
  private activeId: string | null = null
  private seq = 0
  private selectTail: Promise<void> = Promise.resolve()
  private restartOperations = new Map<string, Promise<SelectResult>>()
  private reclaimOperation?: Promise<string | null>
  private reclaimTimer?: ReturnType<typeof setInterval>
  private disposed = false
  private admissionCounter = 0
  private admissions = new Map<string, ExecuteAdmissionClaim>()
  private launchSignatures = new WeakMap<AgentController, string>()

  private spawnAgent(id: string, cwd: string, generation: number): AgentController {
    const signature = this.opts.launchSignature?.()
    const agent = this.opts.createAgent(id, cwd, generation)
    if (signature !== undefined) this.launchSignatures.set(agent, signature)
    return agent
  }

  private launchedWithStaleResources(agent: AgentController): boolean {
    const current = this.opts.launchSignature?.()
    return current !== undefined && this.launchSignatures.get(agent) !== current
  }

  private sharesCwd(cwd: string): boolean {
    return this.opts.sharesCwd?.(cwd) === true
  }

  private admissionKey(runner: Runner): string {
    return `${canonicalCwd(runner.cwd)}#${runner.id}`
  }

  blocksConcurrentRun(_cwd: string, _exceptRunId?: string): boolean {
    return false
  }

  private pruneAdmissions(): void {
    for (const [key, claim] of this.admissions) {
      const runner = this.runners.get(claim.runId)
      if (!runner || runner.generation !== claim.generation || this.admissionKey(runner) !== key) {
        this.admissions.delete(key)
      }
    }
  }

  admitExecute(id: string): { ok: true; token: number } | { ok: false; error: string } {
    const runner = this.runners.get(id)
    if (!runner) return { ok: false, error: pick('运行实例不存在', 'Runtime not found') }
    this.pruneAdmissions()
    const key = this.admissionKey(runner)
    const existing = this.admissions.get(key)
    if (existing) {
      if (admissionClaimedBy(existing, id, runner.generation)) return { ok: true, token: existing.token }
      return { ok: false, error: sameCwdAdmissionError() }
    }
    if (this.blocksConcurrentRun(runner.cwd, id)) return { ok: false, error: sameCwdBusyError() }
    const token = ++this.admissionCounter
    this.admissions.set(key, { token, runId: id, generation: runner.generation, cwd: runner.cwd })
    return { ok: true, token }
  }

  confirmExecute(id: string, token: number): boolean {
    const runner = this.runners.get(id)
    if (!runner) return false
    this.pruneAdmissions()
    const claim = this.admissions.get(this.admissionKey(runner))
    if (claim) return claim.token === token && admissionClaimedBy(claim, id, runner.generation)
    return this.busy(runner) && !this.blocksConcurrentRun(runner.cwd, id)
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
      hasRunningSubagents?: (sessionId: string) => boolean
      onReclaimed?: (entry: { id: string; sessionId?: string; idleMs: number; remaining: number }) => void
      createAgent: (id: string, cwd: string, generation?: number) => AgentController
      launchSignature?: () => string
      prepareNewSession?: (agent: AgentController) => Promise<{ ok: boolean; error?: string }>
      onChanged?: () => void
      resolveCwdConflict?: (target: SelectTarget) => Promise<{ cwd: string } | { reason: string } | null>
      isolationOf?: (cwd: string) => { state: 'waiting' | 'ready' | 'blocked'; branch: string } | undefined
      sharesCwd?: (cwd: string) => boolean
      stopWaitMs?: number
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
    if (this.disposed || this.reclaimTimer) return
    this.reclaimTimer = setInterval(() => {
      void this.reclaimIdle().catch((error) => console.error('[runner-reclaim]', error))
    }, IDLE_RECLAIM_SCAN_MS)
    this.reclaimTimer.unref?.()
  }

  reclaimIdle(): Promise<string | null> {
    if (this.reclaimOperation) return this.reclaimOperation
    const operation = this.serialize(async () => {
      if (this.disposed) return null
      const now = this.now()
      for (const runner of [...this.runners.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
        const state = runner.agent.getState()
        const queue = runner.agent.queueSnapshot()
        const facts = {
          active: runner.id === this.activeId,
          hidden: runner.hidden === true,
          busy: this.busy(runner) || this.awaitingTerminal(runner),
          busyCwd: this.hasBusyCwd(runner.cwd, runner.id),
          ready: runner.agent.getConn().state === 'ready',
          dead: !agentAlive(runner.agent),
          saved: !!state?.sessionFile,
          queued: queue.steering.length > 0 || queue.followUp.length > 0,
          visible: this.opts.isSessionVisible?.(state) ?? true,
          parentProtected: this.opts.isParentProtected?.(state?.sessionId, runner.id) ?? false,
          restarting: this.restartOperations.has(runner.id),
          lastActiveAt: runner.lastActiveAt
        }
        if (facts.active || facts.busy || facts.busyCwd || facts.queued || facts.visible || facts.parentProtected || facts.restarting || (!facts.ready && !facts.dead)) {
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
    void this.respondUiResult(res).catch(() => undefined)
  }

  async respondUiResult(res: Parameters<AgentController['respondUi']>[0], by?: 'desktop' | 'remote'): Promise<UiAnswerResult | undefined> {
    for (const runner of this.runners.values()) {
      if (runner.agent.pendingUiRequests().some((item) => item.id === res.id)) return await runner.agent.respondUiResult(res, by ?? 'desktop')
    }
    return await this.active()?.respondUiResult(res, by ?? 'desktop')
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

  agents(): AgentController[] {
    return [...this.runners.values()].map((runner) => runner.agent)
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

  hasExecutionAdmission(cwd: string): boolean {
    this.pruneAdmissions()
    const key = canonicalCwd(cwd)
    return [...this.admissions.values()].some((claim) => canonicalCwd(claim.cwd) === key)
  }

  private busy(runner: Runner): boolean {
    return executionBusy(
      runner.agent.getState(),
      () => runner.agent.hasRunningBash(),
      () => runner.agent.getPendingUiCount()
    )
  }

  private awaitingTerminal(runner: Runner): boolean {
    return runner.agent.hasPendingTerminalWork?.() ?? false
  }

  private awaitingSubagents(runner: Runner): boolean {
    const sessionId = runner.agent.getState()?.sessionId
    return !!sessionId && (this.opts.hasRunningSubagents?.(sessionId) ?? false)
  }

  private findBySessionFile(sessionFile: string): Runner | undefined {
    const key = canonicalCwd(sessionFile)
    for (const r of this.runners.values()) {
      const file = r.agent.getState()?.sessionFile
      if (file && canonicalCwd(file) === key) return r
    }
    return undefined
  }

  private findStoppingBySessionFile(sessionFile: string): StoppingRunner | undefined {
    const key = canonicalCwd(sessionFile)
    for (const entry of this.stopping) {
      if (entry.sessionFile && canonicalCwd(entry.sessionFile) === key) return entry
    }
    return undefined
  }

  private beginStop(runner: Runner): StoppingRunner {
    const state = runner.agent.getState()
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: StoppingRunner = {
      id: runner.id,
      cwd: runner.cwd,
      sessionId: state?.sessionId,
      sessionFile: state?.sessionFile,
      done,
      finish
    }
    this.stopping.add(entry)
    return entry
  }

  private async runStop(runner: Runner, entry: StoppingRunner): Promise<void> {
    try {
      await runner.agent.stop()
    } catch {
    } finally {
      this.stopping.delete(entry)
      entry.finish()
    }
  }

  private stoppingFor(target: SelectTarget): StoppingRunner[] {
    const file = target.sessionFile ? canonicalCwd(target.sessionFile) : undefined
    const key = canonicalCwd(target.cwd)
    const shared = this.sharesCwd(target.cwd)
    return [...this.stopping].filter(
      (entry) =>
        (!!target.sessionId && entry.sessionId === target.sessionId) ||
        (!!file && !!entry.sessionFile && canonicalCwd(entry.sessionFile) === file) ||
        (!shared && canonicalCwd(entry.cwd) === key)
    )
  }

  private async waitForStopping(target: SelectTarget): Promise<boolean> {
    const deadline = Date.now() + (this.opts.stopWaitMs ?? STOP_WAIT_MS)
    for (;;) {
      const pending = this.stoppingFor(target)
      if (pending.length === 0) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining)
      })
      try {
        const settled = await Promise.race([Promise.all(pending.map((entry) => entry.done)).then(() => true as const), timeout])
        if (!settled) return false
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
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

  async select(target: SelectTarget): Promise<SelectResult> {
    return this.serialize(() => this.selectNow(target))
  }

  private hasAdmission(runnerId: string): boolean {
    this.pruneAdmissions()
    return [...this.admissions.values()].some((claim) => claim.runId === runnerId)
  }

  private async relaunch(idle: Runner, target: SelectTarget): Promise<SelectResult> {
    const previous = idle.agent
    const generation = nextGeneration()
    let replacement: AgentController | undefined
    let failure: string | undefined
    try {
      replacement = this.spawnAgent(idle.id, target.cwd, generation)
      replacement.setRunnerGeneration(generation)
      const started = await replacement.start()
      if (!started.ok) {
        failure = started.error ?? pick('替代运行实例启动失败', 'Replacement runtime failed to start')
      } else {
        let prepared = target.sessionFile
          ? await replacement.switchSession(target.sessionFile)
          : await replacement.newSession()
        if (prepared.ok && !target.sessionFile && this.opts.prepareNewSession) {
          prepared = await this.opts.prepareNewSession(replacement)
        }
        if (!prepared.ok) {
          failure = prepared.error ?? pick('替代运行实例准备会话失败', 'Replacement runtime failed to prepare the session')
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure === undefined && (this.disposed || this.runners.get(idle.id) !== idle || idle.agent !== previous)) {
      failure = pick('运行实例在替换过程中被停止', 'Runtime was stopped during replacement')
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
    return this.result(idle, 'reuse')
  }

  needsIsolation(id: string): boolean {
    const runner = this.runners.get(id)
    return !!runner && !this.busy(runner) && !this.sharesCwd(runner.cwd) && this.hasBusyCwd(runner.cwd, id)
  }

  async isolateIfConflicting(id: string): Promise<{ moved: boolean; error?: string }> {
    const runner = this.runners.get(id)
    if (!runner || !this.needsIsolation(id)) return { moved: false }
    const state = runner.agent.getState()
    const escalated = await this.opts.resolveCwdConflict?.({
      cwd: runner.cwd,
      sessionId: state?.sessionId,
      sessionFile: state?.sessionFile,
      projectId: runner.projectId
    })
    if (!escalated || !('cwd' in escalated) || canonicalCwd(escalated.cwd) === canonicalCwd(runner.cwd)) return { moved: false }
    if (this.hasBusyCwd(escalated.cwd, id)) return { moved: false }
    const result = await this.relocate(id, escalated.cwd)
    return result.ok ? { moved: true } : { moved: false, error: result.error }
  }

  async relocate(id: string, cwd: string): Promise<SelectResult> {
    return this.serialize(async () => {
      const runner = this.runners.get(id)
      if (!runner) return { ok: false, error: pick('运行实例不存在', 'Runtime not found') }
      if (this.busy(runner)) return { ok: false, error: pick('会话正在运行，不能迁移目录', 'The session is running; its folder cannot be changed') }
      const sessionFile = runner.agent.getState()?.sessionFile
      if (!sessionFile) return { ok: false, error: pick('会话还没有记录文件，不能迁移目录', 'The session has no record file yet; its folder cannot be changed') }
      return this.relaunch(runner, { cwd, sessionFile, projectId: runner.projectId, activate: this.activeId === runner.id })
    })
  }

  private async selectNow(target: SelectTarget): Promise<SelectResult> {
    if (this.stoppingFor(target).length > 0) {
      if (target.preview) return { ok: true, deferred: true, deferredReason: 'cwd-busy', sessionId: target.sessionId }
      if (!(await this.waitForStopping(target))) {
        return { ok: false, error: pick('该会话或同一工作目录的运行实例仍在停止中，请稍后再试', 'A runtime for this session or working folder is still stopping; try again shortly') }
      }
    }

    if (target.sessionId || target.sessionFile) {
      const hit = (target.sessionId && this.findBySessionId(target.sessionId)) ||
        (target.sessionFile ? this.findBySessionFile(target.sessionFile) : undefined)
      if (hit && !agentAlive(hit.agent) && !this.busy(hit) && !this.hasAdmission(hit.id)) {
        const sessionFile = target.sessionFile ?? hit.agent.getState()?.sessionFile
        if (sessionFile) return this.relaunch(hit, { ...target, cwd: hit.cwd, sessionFile })
      }
      if (hit) {
        hit.lastActiveAt = this.now()
        if (target.activate !== false) this.activateRunner(hit.id)
        this.opts.onChanged?.()
        return this.result(hit, 'hit')
      }
    }

    const conflict = !this.sharesCwd(target.cwd) && [...this.runners.values()].find(
      (runner) => canonicalCwd(runner.cwd) === canonicalCwd(target.cwd) && this.busy(runner)
    )
    if (conflict) {
      if (target.preview) return { ok: true, deferred: true, deferredReason: 'cwd-busy', sessionId: target.sessionId }
      const escalated = await this.opts.resolveCwdConflict?.(target)
      if (escalated && 'cwd' in escalated && canonicalCwd(escalated.cwd) !== canonicalCwd(target.cwd)) {
        target = { ...target, cwd: escalated.cwd }
        if (this.hasBusyCwd(target.cwd)) {
          return {
            ok: false,
            error:
              pick(
                '隔离目标目录里还有会话正在运行，无法在这里再开一个：两个同时写文件的回合会互相覆盖。请等它跑完或停止它。',
                'A session is still running in the isolated target folder; two turns writing files at once would overwrite each other. Wait for it to finish or stop it.'
              )
          }
        }
      } else {
        const reason = escalated && 'reason' in escalated && escalated.reason ? pick(`（${escalated.reason}）`, ` (${escalated.reason})`) : ''
        return {
          ok: false,
          error:
            pick(
              `同一工作目录还有会话正在运行，无法在这里再开一个：两个同时写文件的回合会互相覆盖。${reason}请等它跑完或停止它。`,
              `A session is still running in this working folder; two turns writing files at once would overwrite each other${reason}. Wait for it to finish or stop it.`
            )
        }
      }
    }

    this.pruneAdmissions()
    const idleCandidates = [...this.runners.values()]
      .filter(
        (runner) =>
          !target.hidden &&
          !runner.hidden &&
          !this.busy(runner) &&
          !this.hasAdmission(runner.id) &&
          !this.awaitingSubagents(runner) &&
          !this.awaitingTerminal(runner) &&
          (target.activate !== false || runner.id !== this.activeId)
      )
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    const idle = idleCandidates.find((runner) => canonicalCwd(runner.cwd) === canonicalCwd(target.cwd)) ??
      (this.runners.size < this.limit ? undefined : idleCandidates[0])

    if (idle) {
      if (canonicalCwd(idle.cwd) !== canonicalCwd(target.cwd) || !agentAlive(idle.agent) || this.launchedWithStaleResources(idle.agent)) {
        return this.relaunch(idle, target)
      }

      const oldProjectId = idle.projectId
      const oldSessionFile = idle.agent.getState()?.sessionFile
      const oldQueue = idle.agent.queueSnapshot?.() ?? { steering: [], followUp: [] }
      idle.generation = nextGeneration()
      idle.agent.setRunnerGeneration(idle.generation)
      idle.projectId = target.projectId
      this.opts.onChanged?.()

      let res: { ok: boolean; error?: string }
      try {
        res = target.sessionFile
          ? await idle.agent.switchSession(target.sessionFile)
          : await idle.agent.newSession()
      } catch (error) {
        res = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (res.ok && !target.sessionFile && this.opts.prepareNewSession) res = await this.opts.prepareNewSession(idle.agent)
      if (this.disposed || this.runners.get(idle.id) !== idle) {
        return { ok: false, error: pick('运行实例在切换会话过程中被停止', 'Runtime was stopped while switching sessions') }
      }
      if (!res.ok) {
        const currentFile = idle.agent.getState()?.sessionFile
        const stillOld = !!oldSessionFile && currentFile === oldSessionFile
        let restored = stillOld
        if (!stillOld && oldSessionFile) {
          try {
            restored = (await idle.agent.switchSession(oldSessionFile)).ok
          } catch (error) {
            console.warn('[runners] 回滚到原会话失败，请重新选择会话', error)
          }
        }
        if ((oldQueue.steering.length || oldQueue.followUp.length) && typeof idle.agent.restoreQueueSnapshot === 'function') {
          try { await idle.agent.restoreQueueSnapshot(oldQueue) } catch { }
        }
        idle.projectId = oldProjectId
        if (!restored) {
          await this.stopOne(idle.id, true)
          return { ok: false, error: pick('新会话没有准备好，原来的会话也没能恢复，已经停止这个运行实例；请重新选择会话', 'The new session was not ready and the previous session could not be restored; this runtime was stopped. Select a session again') }
        }
        this.opts.onChanged?.()
        return { ok: false, error: res.error }
      }
      idle.cwd = target.cwd
      idle.lastActiveAt = this.now()
      if (target.activate !== false) this.activateRunner(idle.id)
      this.opts.onChanged?.()
      return this.result(idle, 'reuse')
    }

    if (this.runners.size >= this.limit) {
      if (target.preview) return { ok: true, deferred: true, deferredReason: 'limit', sessionId: target.sessionId }
      return {
        ok: false,
        error:
          pick(
            `同时运行的会话已达上限（${this.limit} 个）。先等其中一个跑完，或停止它，再试 —— 不会为了腾位置停掉正在跑的会话。`,
            `Concurrent session limit reached (${this.limit}). Wait for one to finish or stop it; running sessions are never stopped to make room.`
          )
      }
    }

    if (this.disposed) return { ok: false, error: pick('运行实例正在重启，请稍后再打开这个会话', 'Runtime is restarting; try opening this session again shortly') }
    const id = `r${++this.seq}`
    const generation = nextGeneration()
    const agent = this.spawnAgent(id, target.cwd, generation)
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
        failure = started.error ?? pick('实例启动失败', 'Runtime failed to start')
      } else if (target.sessionFile) {
        const sw = await agent.switchSession(target.sessionFile)
        if (!sw.ok) failure = sw.error ?? pick('切换会话失败', 'Failed to switch session')
      } else {
        if (this.opts.prepareNewSession) {
          const prepared = await this.opts.prepareNewSession(agent)
          if (!prepared.ok) failure = prepared.error ?? pick('新会话模型初始化失败', 'Failed to initialize the model for the new session')
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure === undefined && (this.disposed || this.runners.get(id) !== runner)) {
      failure = pick('运行实例在启动过程中被停止', 'Runtime was stopped during startup')
      if (this.runners.get(id) !== runner) {
        await agent.stop().catch(() => undefined)
        return { ok: false, error: failure }
      }
    }
    if (failure !== undefined) {
      await this.discardNewRunner(id, runner, previousActive)
      return { ok: false, error: failure }
    }
    this.opts.onChanged?.()
    return this.result(runner, 'new')
  }

  private async discardNewRunner(id: string, runner: Runner, previousActive: string | null): Promise<void> {
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
    if (!runner) return { ok: false, error: pick(`运行实例不存在：${id}`, `Runtime not found: ${id}`) }
    if (this.busy(runner)) return { ok: false, error: pick('目标运行实例仍忙，拒绝重载', 'Target runtime is busy; reload refused') }
    if (this.hasBusyWorkspace(runner.cwd, id)) {
      return { ok: false, error: pick('工作目录重叠的其它运行实例还在工作，拒绝重载', 'Another runtime working in an overlapping folder; reload refused') }
    }
    const sessionFile = runner.agent.getState()?.sessionFile
    if (!sessionFile) return { ok: false, error: pick('目标会话尚无已保存的会话文件，无法安全重载', 'Target session has no saved file yet; cannot reload safely') }

    const previous = runner.agent
    const previousGeneration = runner.generation
    const queue = previous.queueSnapshot()
    const generation = nextGeneration()
    const replacement = this.spawnAgent(runner.id, runner.cwd, generation)
    runner.agent = replacement
    runner.generation = generation
    this.opts.onChanged?.()

    let failure: string | undefined
    try {
      const started = await replacement.start()
      if (!started.ok) failure = started.error ?? pick('替代运行实例启动失败', 'Replacement runtime failed to start')
      if (!failure) {
        const switched = await replacement.switchSession(sessionFile)
        if (!switched.ok) failure = switched.error ?? pick('替代运行实例载入原会话失败', 'Replacement runtime failed to load the original session')
      }
      if (!failure) {
        const restored = await replacement.restoreQueueSnapshot(queue)
        if (!restored.ok) failure = restored.error ?? pick('替代运行实例恢复排队消息失败', 'Replacement runtime failed to restore queued messages')
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    const removed = this.disposed || this.runners.get(id) !== runner
    if (removed) {
      await replacement.stop().catch(() => undefined)
      await previous.stop().catch(() => undefined)
      this.opts.onChanged?.()
      return { ok: false, error: failure ?? pick('运行实例在重载过程中被停止', 'Runtime was stopped during reload') }
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
    if (!r) {
      for (const entry of [...this.stopping]) {
        if (entry.id === id) await entry.done
      }
      return false
    }
    const entry = this.beginStop(r)
    this.runners.delete(id)
    this.pruneAdmissions()
    if (this.activeId === id && !preserveSelection) this.activeId = null
    await this.runStop(r, entry)
    this.opts.onChanged?.()
    return true
  }

  async stopBySessionFile(sessionFile: string): Promise<boolean> {
    const hit = this.findBySessionFile(sessionFile)
    if (!hit) {
      const pending = this.findStoppingBySessionFile(sessionFile)
      if (!pending) return false
      await pending.done
      return true
    }
    return this.stopOne(hit.id)
  }

  async stopByCwd(cwd: string): Promise<number> {
    const normalized = canonicalCwd(cwd)
    const ids = [...this.runners.values()]
      .filter((r) => canonicalCwd(r.cwd) === normalized)
      .map((r) => r.id)
    for (const id of ids) await this.stopOne(id)
    await Promise.all([...this.stopping].filter((entry) => canonicalCwd(entry.cwd) === normalized).map((entry) => entry.done))
    return ids.length
  }

  async stopAll(): Promise<void> {
    this.disposed = true
    if (this.reclaimTimer) clearInterval(this.reclaimTimer)
    this.reclaimTimer = undefined
    const all = [...this.runners.values()].map((runner) => ({ runner, entry: this.beginStop(runner) }))
    const earlier = [...this.stopping].filter((entry) => !all.some((item) => item.entry === entry))
    this.runners.clear()
    this.admissions.clear()
    this.activeId = null
    for (const { runner, entry } of all) await this.runStop(runner, entry)
    await Promise.all(earlier.map((entry) => entry.done))
    this.opts.onChanged?.()
  }

  hasBusy(): boolean {
    return [...this.runners.values()].some((r) => this.busy(r))
  }

  private runnerHasPendingWork(runner: Runner): boolean {
    if (this.busy(runner) || this.awaitingTerminal(runner) || this.awaitingSubagents(runner)) return true
    const queue = runner.agent.queueSnapshot()
    return queue.steering.length > 0 || queue.followUp.length > 0
  }

  sessionHasPendingWork(sessionId: string): boolean {
    return [...this.runners.values()].some((runner) => runner.agent.getState()?.sessionId === sessionId && this.runnerHasPendingWork(runner))
  }

  hasPendingWorkExcept(exceptRunId?: string): boolean {
    return [...this.runners.values()].some((runner) => runner.id !== exceptRunId && this.runnerHasPendingWork(runner))
  }

  hasBusyCwd(cwd: string, exceptRunId?: string): boolean {
    const key = canonicalCwd(cwd)
    return [...this.runners.values()].some(
      (runner) => runner.id !== exceptRunId && canonicalCwd(runner.cwd) === key && this.busy(runner)
    ) || [...this.stopping].some((entry) => entry.id !== exceptRunId && canonicalCwd(entry.cwd) === key)
  }

  hasBusyWorkspace(cwd: string, exceptRunId?: string): boolean {
    return [...this.runners.values()].some(
      (runner) => runner.id !== exceptRunId && this.busy(runner) && workspacePathsOverlap(runner.cwd, cwd)
    )
  }

  busyRoots(): string[] {
    this.pruneAdmissions()
    const roots = new Set<string>()
    for (const runner of this.runners.values()) {
      const queue = runner.agent.queueSnapshot()
      const writes = this.busy(runner) || this.awaitingTerminal(runner) || queue.steering.length > 0 || queue.followUp.length > 0
      if (writes) roots.add(runner.cwd)
    }
    for (const claim of this.admissions.values()) roots.add(claim.cwd)
    return [...roots]
  }

  guardExecute(id: string): ExecuteGuardResult {
    const runner = this.runners.get(id)
    if (!runner) return { ok: true }
    return guardSameCwdExecute(
      { runnerId: runner.id, cwd: runner.cwd, selfBusy: this.busy(runner) },
      (cwd, exceptRunId) => this.blocksConcurrentRun(cwd, exceptRunId)
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
