import type { IpcRegistrar } from './registrar'
import { defaultWorkMode, workModeKeyFor, resolveWorkMode, pushWorkMode, pushGoal, cancelGoalResume, goals } from '../goal-coordinator'
import { HANDOFF_COMMIT_ENABLED, HANDOFF_THRESHOLD_EFFECTIVE, handoffPending, handoffLastCheck, abandonHandoff } from '../handoff-coordinator'
import { eventsForSession } from '../../shared/handoff-diagnostics'
import { normalizeChainKey } from '../../shared/session-chain'
import { keepsGoalResumeOnModeChange, normalizePursuedBrief } from '../../shared/goal'
import { normalizeSessionFileKey, sameWorkModeIdentity, writeWorkModeSnapshot } from '../work-mode-service'
import { normalizeWorkMode } from '../../shared/work-mode'
import type { WorkMode, WorkModeState } from '../../shared/work-mode'
import type { RunnerRegistry } from '../runners'
import type { WorkModeStore } from '../work-mode-service'
import type { HandoffStore } from '../handoff-service'
import type { HandoffTransactionStore } from '../handoff-transaction-service'
import type { SessionChainStore } from '../session-chain-service'
import type { HandoffDiagnostics } from '../handoff-diagnostics'
import type { MainPush } from '../../shared/ipc'

export interface GoalIpcDeps {
  registry(): RunnerRegistry | null
  workModes: WorkModeStore
  handoffs: HandoffStore
  handoffTransactions: HandoffTransactionStore
  sessionChains: SessionChainStore
  handoffDiag: HandoffDiagnostics
  pushFrom(runnerId: string, msg: MainPush): void
  scheduleSessionWork(id: string, reason: string): Promise<void>
}

export function registerGoalIpc(ipc: IpcRegistrar, deps: GoalIpcDeps): void {
  const { handle } = ipc
  const { registry, workModes, handoffs, handoffTransactions, sessionChains, handoffDiag, pushFrom, scheduleSessionWork } = deps
  handle('yan:getWorkMode', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { mode: defaultWorkMode(), revision: 0 } satisfies WorkModeState
    return resolveWorkMode(id)
  })
  handle('yan:getGoal', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { goal: goals.state(''), mode: { mode: defaultWorkMode(), revision: 0 } }
    await goals.load()
    return { goal: goals.state(workModeKeyFor(id)), mode: await resolveWorkMode(id) }
  })

  handle('yan:setGoalReadyApproval', async (mode: unknown, expectedGoalRevision: unknown) => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (mode !== 'automatic' && mode !== 'review') {
      return { ok: false as const, error: 'bad_mode' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    const workMode = await resolveWorkMode(id)
    if (workMode.mode !== 'clarify') {
      return { ok: false as const, error: 'clarify_required' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const res = await goals.setReadyApprovalMode(
      workModeKeyFor(id),
      mode,
      typeof expectedGoalRevision === 'number' ? expectedGoalRevision : Number.NaN
    )
    if (!res.ok) return { ok: false as const, error: res.code, goal: res.goal }
    await pushGoal(id)
    return { ok: true as const, goal: res.goal }
  })

  handle('yan:approveGoalReady', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (request.runnerId !== id) {
      return { ok: false as const, error: 'stale_runner' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const key = workModeKeyFor(id)
    const currentGoal = goals.state(key)
    const transitionId = typeof request.transitionId === 'string' ? request.transitionId : ''
    const expectedGoalRevision = typeof request.goalRevision === 'number' ? request.goalRevision : Number.NaN
    const expectedModeRevision = typeof request.modeRevision === 'number' ? request.modeRevision : Number.NaN
    if (!currentGoal.pendingReady) {
      const replay = await goals.approveReadyReview(key, {
        transitionId,
        goalRevision: expectedGoalRevision,
        modeRevision: expectedModeRevision
      })
      return replay.ok
        ? { ok: true as const, replayed: true, goal: replay.goal }
        : { ok: false as const, error: replay.code, goal: replay.goal }
    }
    const currentMode = await resolveWorkMode(id)
    if (currentMode.mode !== 'clarify' || currentMode.revision !== expectedModeRevision) {
      return { ok: false as const, error: 'stale_mode' as const, goal: currentGoal }
    }
    if (currentGoal.revision !== expectedGoalRevision) {
      return { ok: false as const, error: 'stale_goal' as const, goal: currentGoal }
    }
    if (registry()?.activeRunner()?.id !== id) {
      return { ok: false as const, error: 'stale_runner' as const, goal: currentGoal }
    }
    const executeGuard = registry()?.guardExecute(id)
    if (executeGuard && !executeGuard.ok) {
      return { ok: false as const, error: executeGuard.error, goal: currentGoal }
    }

    const switched = await workModes.set(key, 'standard', currentMode.revision)
    if (!switched.ok) {
      await pushWorkMode(id)
      return { ok: false as const, error: switched.error ?? 'stale_mode', goal: currentGoal }
    }
    const approved = await goals.approveReadyReview(key, {
      transitionId,
      goalRevision: expectedGoalRevision,
      modeRevision: expectedModeRevision
    })
    if (!approved.ok) {
      const restored = await workModes.set(key, 'clarify', switched.state.revision)
      await pushWorkMode(id)
      await pushGoal(id)
      if (!restored.ok) {
        console.error('[goal] 审批失败且工作模式回滚失败，请手动切回澄清模式', { key, goalRevision: expectedGoalRevision })
        pushFrom(id, { ch: 'log', payload: { text: '[任务计划] 审批失败且模式未能回滚；请在当前会话手动切回澄清模式，再刷新计划。' } })
      }
      return { ok: false as const, error: restored.ok ? approved.code : 'approval_rollback_failed', goal: approved.goal }
    }
    await pushWorkMode(id)
    await pushGoal(id)
    if (approved.replayed) return { ok: true as const, replayed: true, goal: approved.goal }

    const started = await registry()?.agentOf(id)?.send('请按刚才批准的计划开始执行。', undefined, 'followUp')
    return {
      ok: true as const,
      replayed: false,
      started: started?.ok === true,
      startError: started?.error,
      goal: approved.goal
    }
  })

  handle('yan:modifyGoalReady', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const, goal: goals.state('') }
    if (request.runnerId !== id) {
      return { ok: false as const, error: 'stale_runner' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    const currentMode = await resolveWorkMode(id)
    if (currentMode.mode !== 'clarify' || currentMode.revision !== request.modeRevision) {
      return { ok: false as const, error: 'stale_mode' as const, goal: goals.state(workModeKeyFor(id)) }
    }
    await goals.load()
    const res = await goals.modifyReadyReview(workModeKeyFor(id), {
      transitionId: typeof request.transitionId === 'string' ? request.transitionId : '',
      goalRevision: typeof request.goalRevision === 'number' ? request.goalRevision : Number.NaN
    })
    if (!res.ok) return { ok: false as const, error: res.code, goal: res.goal }
    await pushGoal(id)
    return { ok: true as const, goal: res.goal }
  })

  handle('yan:setGoal', async (brief: unknown) => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false as const, error: 'no_session' as const }
    const normalized = normalizePursuedBrief(brief)
    if (!normalized) return { ok: false as const, error: 'incomplete' as const }
    await goals.load()
    const goal = await goals.startPursued(workModeKeyFor(id), normalized)
    await pushGoal(id)
    return { ok: true as const, goal }
  })
  handle('yan:getHandoff', async () => {
    await handoffDiag.load()
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return {
        sessionKey: '',
        tally: null,
        segmentTally: null,
        chainSegments: 0,
        package: null,
        pending: false,
        threshold: HANDOFF_THRESHOLD_EFFECTIVE,
        transaction: null,
        events: handoffDiag.recent(40),
        autoCommit: HANDOFF_COMMIT_ENABLED
      }
    }
    const key = workModeKeyFor(id)
    await handoffs.load()
    await handoffTransactions.load()
    await sessionChains.load()
    const chain = sessionChains.chainOf(key)
    const head = chain?.segments?.[0]?.sessionFile ?? key
    const entry = handoffs.state(head)
    const tx = handoffTransactions.latestForSession(key)
    const chainKeys = new Set<string>([key])
    for (const segment of chain?.segments ?? []) chainKeys.add(segment.sessionFile)
    const events = eventsForSession(handoffDiag.recent(), { keys: chainKeys, runnerId: id }).slice(-40)
    return {
      sessionKey: key,
      tally: entry.tally,
      segmentTally: handoffs.state(key).tally,
      chainSegments: chain?.segments.length ?? 1,
      package: entry.package,
      pending: handoffPending.has(id),
      threshold: HANDOFF_THRESHOLD_EFFECTIVE,
      transaction: tx
        ? {
            handoffId: tx.handoffId,
            stage: tx.stage,
            destinationSession: normalizeChainKey(tx.destinationSession),
            receipts: tx.receipts ?? {},
            steps: tx.steps.slice(-4),
            resumeAttempts: tx.resumeAttempts
          }
        : null,
      events,
      autoCommit: HANDOFF_COMMIT_ENABLED
    }
  })
  handle('yan:confirmHandoff', async (handoffId: string) => {
    await handoffTransactions.load()
    const tx = handoffTransactions.snapshot().transactions[String(handoffId ?? '')]
    if (!tx) return { ok: false, error: 'not-found' }
    const sourceRunner = registry()?.activeRunner()?.id
    if (!sourceRunner || workModeKeyFor(sourceRunner) !== tx.sourceSession) return { ok: false, error: 'session-mismatch' }
    if (typeof tx.receipts?.sentAt !== 'number') return { ok: false, error: 'not-sent' }
    const done = await handoffTransactions.step(tx.handoffId, 'resumed', 'manual-confirmed')
    handoffDiag.record({
      stage: 'commit',
      outcome: 'manual-confirmed',
      reason: 'user-verified',
      runnerId: sourceRunner,
      sessionKey: tx.sourceSession
    })
    return { ok: done.advanced || done.tx?.stage === 'resumed' }
  })

  handle('yan:retryHandoff', async () => {
    const id = registry()?.activeRunner()?.id
    if (!id) return { ok: false, error: 'pi 未运行' }
    await handoffDiag.load()
    handoffDiag.record({
      stage: 'generate',
      outcome: 'manual-retry',
      runnerId: id,
      sessionKey: workModeKeyFor(id)
    })
    await abandonHandoff(id, 'manual-retry')
    handoffLastCheck.delete(id)
    void scheduleSessionWork(id, 'manual-retry').catch((error) => console.error('[handoff] 重试调度失败', error))
    return { ok: true }
  })
  handle('yan:setWorkMode', async (mode: WorkMode, expectedRevision?: number) => {
    const id = registry()?.activeRunner()?.id
    if (!id) {
      return { ok: false, state: { mode: normalizeWorkMode(mode), revision: 0 }, error: 'pi 未运行' }
    }
    const captureIdentity = () => {
      const session = registry()?.agentOf(id)?.getState()
      const runtime = registry()?.runtimeOf(id)
      return {
        id,
        generation: runtime?.generation,
        sessionId: session?.sessionId,
        sessionFile: session?.sessionFile
      }
    }
    await workModes.load()
    const identity = captureIdentity()
    const key = workModeKeyFor(id)
    const guard = () => sameWorkModeIdentity(identity, captureIdentity()) && workModeKeyFor(id) === key
    const res = await workModes.set(key, mode, expectedRevision)
    if (res.ok) {
      await goals.load()
      let goal = goals.state(key)
      if (mode !== 'clarify' && goal.pendingReady) {
        await goals.cancelReadyReview(key)
        goal = goals.state(key)
      }
      const pursue = goal.pursue === true
      await goals.setPaused(key, false).catch(() => {})
      const stillRuns = keepsGoalResumeOnModeChange(mode, pursue)
      if (!stillRuns) {
        await cancelGoalResume(id).catch(() => {})
        handoffDiag.record({
          stage: 'goal-continue',
          outcome: 'cancelled',
          reason: 'work-mode-changed',
          runnerId: id,
          sessionKey: key,
          detail: { mode, pursue }
        })
      }
    }
    await goals.load()
    const planApprovalPending = goals.state(key).pendingReady !== null
    const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
    await writeWorkModeSnapshot(
      id,
      { ...res.state, planApprovalPending },
      undefined,
      {
        guard,
        owner: {
          ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
          ...(sessionFile ? { sessionFile } : {})
        }
      }
    ).catch(() => false)
    if (guard()) pushFrom(id, { ch: 'work-mode', payload: res.state })
    if (res.ok && mode !== 'clarify' && guard()) await pushGoal(id)
    return res
  })
}
