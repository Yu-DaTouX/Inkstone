import type { MainPush } from '../shared/ipc'
import { readFile } from 'node:fs/promises'
import { RunnerRegistry } from './runners'
import { getSettings } from './settings'
import { handoffContinuationProblem } from '../shared/handoff-context'
import { handoffReasonText } from '../shared/handoff-notice'
import { GoalStore, writeGoalResumeSnapshotIfVacant } from './goal-service'
import { HandoffStore, HandoffRequestStore, buildHandoffRequest } from './handoff-service'
import { HandoffDiagnostics } from './handoff-diagnostics'
import { ownsHandoffOperation, EligibilityRejectLog } from '../shared/handoff-schedule'
import { HandoffTransactionStore } from './handoff-transaction-service'
import { SessionChainStore } from './session-chain-service'
import { HandoffRunner } from './handoff-runner'
import type { HandoffSessionHandle, HandoffSessionTarget } from './handoff-runner'
import { normalizeChainKey } from '../shared/session-chain'
import { HANDOFF_AUTO_COMPACT_THRESHOLD, handoffCommitEnabled, handoffSummary, parseHandoffOutput, sanitizeHandoffPackage } from '../shared/handoff'
import type { HandoffPackage } from '../shared/handoff'

import { isActiveGoalPhase, keepsGoalResumeOnModeChange } from '../shared/goal'
import { WorkModeStore, normalizeSessionFileKey, readWorkModeSnapshot, sameWorkModeIdentity, writeWorkModeSnapshot } from './work-mode-service'
import type { WorkMode, WorkModeState } from '../shared/work-mode'
import type { SessionState } from '../shared/ipc'

export interface HandoffHost {
  runners(): RunnerRegistry | null
  defaultWorkMode(): WorkMode
  goals: GoalStore
  handoffs: HandoffStore
  workModes: WorkModeStore
  sessionChains: SessionChainStore
  handoffTransactions: HandoffTransactionStore
  handoffDiag: HandoffDiagnostics
  workModeKeyFor(id: string): string
  resolveWorkMode(id: string): Promise<WorkModeState>
  pushFrom(runnerId: string, msg: MainPush): void
  push(msg: MainPush): void
  maybeArmGoalContinue(id: string): Promise<void>
  cancelGoalResume(id: string): Promise<void>
  applyGoalResume(id: string): Promise<void>
  consumeRepeatBlocks(id: string): Promise<void>
  rememberRunnerSession(
    result: { ok: boolean; id?: string; sessionId?: string },
    target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
  ): Promise<void>
  pushRunners(): void
  pushRunnerSnapshot(id: string, opts?: { chainHistory?: boolean }): Promise<void>
  openHandoffSession(target: HandoffSessionTarget): Promise<HandoffSessionHandle>
  projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined
}

let host: HandoffHost

export function configureHandoffCoordinator(next: HandoffHost): void {
  host = next
  handoffRunner = createHandoffRunner()
}

export const HANDOFF_COMMIT_ENABLED = handoffCommitEnabled(process.env)

export function handoffAlert(message: string, notifyType: 'info' | 'warning' | 'error'): void {
  const msg: MainPush = {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  }
  const active = host.runners()?.activeRunnerId
  if (active) host.pushFrom(active, msg)
  else host.push(msg)
}

function createHandoffRunner(): HandoffRunner {
  return new HandoffRunner({
    transactions: host.handoffTransactions,
    chains: host.sessionChains,
    stopRunner: async (runId) => (await host.runners()?.stopOne(runId, handoffPending.has(runId))) ?? false,
    openSession: (target) => host.openHandoffSession(target),
    send: async (runId, text, resumeId) => {
      await host.goals.load()
      if (host.goals.isPaused(host.workModeKeyFor(runId))) return { ok: false, error: '目标已暂停' }
      const written = await writeGoalResumeSnapshotIfVacant(runId, {
        operationId: resumeId,
        at: Date.now(),
        kind: 'handoff',
        summary: text
      }).catch(() => false)
      if (!written) return { ok: false, error: '续行槽位正被另一个操作占用（等它被消费后重试）' }
      return { ok: true }
    },
    readSessionText: (sessionFile) => readFile(sessionFile, 'utf8'),
    notify: handoffAlert,
    shouldActivate: (sourceRunId) => host.runners()?.activeRunnerId === sourceRunId,
    onDestinationReady: async (info) => {
      for (const pending of handoffPending.values()) {
        if (pending.request.sessionKey === normalizeChainKey(info.sourceSession)) pending.destinationRunId = info.runId
      }
      await inheritForHandoff(info)
    },
    onLinked: publishHandoffReplacement
  })
}

export let handoffRunner: HandoffRunner

export async function publishHandoffReplacement(sourceId: string, destId: string): Promise<void> {
  const pending = handoffPending.get(sourceId)
  const source = pending?.sourceState
  const state = host.runners()?.agentOf(destId)?.getState()
  const runtime = host.runners()?.runtimeOf(destId)
  if (!source || !state || !runtime) return
  const identity = {
    sessionId: state.sessionId,
    conversationId: source.conversationId ?? source.sessionId,
    conversationFile: source.conversationFile ?? source.sessionFile
  }
  handoffIdentities.set(destId, identity)
  const active = host.runners()?.publishReplacement(sourceId, destId) ?? false
  host.push({ ch: 'handoff-rebind', payload: {
    sourceRunId: sourceId, sourceSessionId: source.sessionId, runtime,
    state: { ...state, ...identity }, active
  } })
  host.pushRunners()
  await host.rememberRunnerSession({ ok: true, id: destId, sessionId: state.sessionId }, {
    cwd: state.cwd ?? '', projectId: runtime.projectId ?? undefined,
    scope: runtime.projectId ? 'project' : 'global'
  })
  await host.pushRunnerSnapshot(destId, { chainHistory: true })
}

export const handoffRequests = new HandoffRequestStore()

export const HANDOFF_THRESHOLD_EFFECTIVE = (() => {
  const raw = Number(process.env.YAN_HANDOFF_THRESHOLD)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : HANDOFF_AUTO_COMPACT_THRESHOLD
})()

export interface HandoffPendingEntry {
  request: ReturnType<typeof buildHandoffRequest>
  interval: NodeJS.Timeout
  timeout: NodeJS.Timeout
  goalId: string
  mismatchNoted?: boolean
  collecting?: boolean
  settled?: Promise<void>
  settle?: () => void
  cancelled?: boolean
  destinationRunId?: string
  sourceState?: SessionState
}

export const handoffPending = new Map<string, HandoffPendingEntry>()
export const handoffIdentities = new Map<string, { sessionId: string; conversationId: string; conversationFile?: string }>()

export function hasHandoffOperation(id: string): boolean {
  return handoffPending.has(id) || [...handoffPending.values()].some((op) => op.destinationRunId === id)
}


export const handoffLastCheck = new Map<string, number>()
export const HANDOFF_CHECK_INTERVAL_MS = 1_000

export const handoffEligibilityLog = new EligibilityRejectLog()

export const HANDOFF_WAIT_MS = 90_000
export const HANDOFF_POLL_MS = 1_000

export function handoffNotify(id: string, message: string, notifyType: 'info' | 'warning' | 'error'): void {
  host.pushFrom(id, {
    ch: 'notify',
    payload: { id: `handoff-${Date.now()}`, method: 'notify', notifyType, message }
  })
}

export async function tryArmHandoff(_id: string, _reason: string): Promise<boolean> { return false }

export async function abandonHandoff(id: string, why: string, operationId?: string): Promise<void> {
  const pending = handoffPending.get(id)
  if (!pending) return
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return
  if (why === 'timeout' && pending.collecting) {
    pending.timeout = setTimeout(() => void abandonHandoff(id, why, operationId), HANDOFF_POLL_MS)
    pending.timeout.unref?.()
    return
  }
  if (why === 'timeout' && (await collectHandoffResult(id, operationId))) return
  if (handoffPending.get(id) !== pending) return
  pending.cancelled = true
  clearInterval(pending.interval)
  clearTimeout(pending.timeout)
  if (!pending.collecting) handoffPending.delete(id)
  await handoffRequests.clearResult(id).catch(() => {})
  await handoffRequests.clearRequest(id).catch(() => {})
  if (why === 'timeout') {
    console.warn(
      `[handoff] 交接包生成超时：宿主等了 ${Math.round(HANDOFF_WAIT_MS / 1000)}s 也没等到结果（请求已清）`
    )
    handoffNotify(id, '交接包生成超时，已放弃（会话不受影响）', 'warning')
  }
  host.handoffDiag.record({
    stage: 'generate',
    outcome: 'abandoned',
    reason: why,
    op: pending.request.operationId,
    handoffId: pending.request.handoffId,
    runnerId: id,
    sessionKey: pending.request.sessionKey,
    detail: { waitedMs: HANDOFF_WAIT_MS }
  })
  void host.maybeArmGoalContinue(id).catch(() => undefined)
}

export async function collectHandoffResult(id: string, operationId?: string): Promise<boolean> {
  const pending = handoffPending.get(id)
  if (!pending) return false
  if (!ownsHandoffOperation(pending.request.operationId, operationId)) return false
  if (pending.collecting || pending.cancelled) return false
  pending.collecting = true
  pending.settled = new Promise<void>((resolve) => { pending.settle = resolve })
  let handled = false
  try {
    let result
    try {
      result = await handoffRequests.readResult(id)
    } catch {
      return false
    }
    if (handoffPending.get(id) !== pending || pending.cancelled) return false
    if (!result) return false
    if (result.handoffId !== pending.request.handoffId || result.operationId !== pending.request.operationId) {
      if (!pending.mismatchNoted) {
        pending.mismatchNoted = true
        host.handoffDiag.record({
          stage: 'generate',
          outcome: 'result-mismatch',
          reason: 'result-not-for-this-operation',
          op: pending.request.operationId,
          handoffId: pending.request.handoffId,
          runnerId: id,
          sessionKey: pending.request.sessionKey,
          detail: {
            gotHandoffId: result.handoffId,
            gotOperationId: result.operationId,
            ms: result.ms
          }
        })
      }
      return false
    }

    clearInterval(pending.interval)
    clearTimeout(pending.timeout)
    handled = true
    await handoffRequests.clearResult(id).catch(() => {})
    await handoffRequests.clearRequest(id).catch(() => {})

    const base = {
      op: pending.request.operationId,
      handoffId: pending.request.handoffId,
      runnerId: id,
      sessionKey: pending.request.sessionKey
    }

    if (result.error) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'failed', reason: result.error, ...base, detail: { ms: result.ms } })
      handoffNotify(id, `交接包生成失败：${result.error.slice(0, 120)}`, 'error')
      return true
    }
    const parsed = parseHandoffOutput(result.text)
    if (!parsed.ok) {
      const cutByLength = result.truncated === true
      host.handoffDiag.record({
        stage: 'generate',
        outcome: 'unparsable',
        reason: cutByLength ? 'truncated' : parsed.reason,
        ...base,
        detail: {
          chars: result.text.length,
          ms: result.ms,
          stopReason: result.stopReason ?? null,
          attempts: result.attempts ?? 1,
          truncated: cutByLength
        }
      })
      handoffNotify(
        id,
        cutByLength
          ? `上下文交接未完成：${handoffReasonText('truncated')}，将尝试在原会话继续`
          : `上下文交接未完成：${handoffReasonText(parsed.reason)}，将尝试在原会话继续`,
        'error'
      )
      return true
    }
    const problem = handoffContinuationProblem(parsed.value)
    if (problem) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'incomplete', reason: problem, ...base })
      handoffNotify(id, '交接内容缺少剩余工作或下一步，保留原会话继续', 'error')
      return true
    }
    const pkg = sanitizeHandoffPackage(parsed.value, {
      sourceSession: pending.request.sessionKey,
      sourceHead: pending.request.sourceHead,
      mode: pending.request.mode,
      model: pending.request.model
    })
    if (!pkg) {
      host.handoffDiag.record({ stage: 'generate', outcome: 'incomplete', reason: 'missing-required-fields', ...base })
      handoffNotify(id, '交接包缺必填栏（目标 / 交付物），已丢弃这份', 'error')
      return true
    }
    try {
      await host.handoffs.setPackage(pending.request.sessionKey, pkg)
    } catch (error) {
      host.handoffDiag.record({
        stage: 'generate',
        outcome: 'persist-failed',
        reason: error instanceof Error ? error.message : String(error),
        ...base
      })
      handoffNotify(id, '交接包落盘失败，已放弃（下一次压缩后再试）', 'error')
      return true
    }
    host.handoffDiag.record({ stage: 'generate', outcome: 'package-ready', ...base, detail: { ms: result.ms, attempts: result.attempts ?? 1, stopReason: result.stopReason ?? null } })
    handoffNotify(id, `交接包已生成：${handoffSummary(pkg)}`, 'info')
    if (HANDOFF_COMMIT_ENABLED) {
      await commitHandoff({
        runnerId: id,
        handoffId: pending.request.handoffId,
        operationId: pending.request.operationId,
        sessionKey: pending.request.sessionKey,
        goalId: pending.goalId,
        sourceHead: pending.request.sourceHead,
        pkg
      })
    }
    return true
  } finally {
    pending.collecting = false
    if ((handled || pending.cancelled) && handoffPending.get(id) === pending) {
      handoffPending.delete(id)
      if (!pending.cancelled) await host.maybeArmGoalContinue(pending.destinationRunId ?? id).catch(() => undefined)
    }
    pending.settle?.()
  }
}

export async function revalidateHandoff(input: {
  runnerId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pending = handoffPending.get(input.runnerId)
  if (!pending || pending.cancelled) return { ok: false, reason: 'operation-cancelled' }
  if (pending.request.operationId !== input.operationId) return { ok: false, reason: 'operation-replaced' }
  const agent = host.runners()?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return { ok: false, reason: 'runner-gone' }
  if (state.isAgentRunning || state.isStreaming) return { ok: false, reason: 'not-idle' }
  if (host.workModeKeyFor(input.runnerId) !== input.sessionKey) return { ok: false, reason: 'source-session-changed' }
  await host.goals.load()
  if (host.goals.isPaused(input.sessionKey)) return { ok: false, reason: 'user-paused' }
  const goal = host.goals.state(input.sessionKey)
  if (!isActiveGoalPhase(goal.phase) || (goal.goalId ?? '') !== input.goalId) {
    return { ok: false, reason: 'goal-changed' }
  }
  const mode = await host.resolveWorkMode(input.runnerId)
  if (!keepsGoalResumeOnModeChange(mode.mode, goal.pursue === true)) return { ok: false, reason: 'mode-changed' }
  let head: string | null
  try {
    head = (await agent.getMessages()).at(-1)?.id ?? null
  } catch {
    return { ok: true }
  }
  if ((input.sourceHead ?? null) !== head) return { ok: false, reason: 'source-watermark-moved' }
  return { ok: true }
}

export async function commitHandoff(input: {
  runnerId: string
  handoffId: string
  operationId: string
  sessionKey: string
  goalId: string
  sourceHead: string | null
  pkg: HandoffPackage
}): Promise<void> {
  const agent = host.runners()?.agentOf(input.runnerId)
  const state = agent?.getState()
  if (!agent || !state) return
  const operation = handoffPending.get(input.runnerId)
  if (operation) operation.sourceState = { ...state, ...handoffIdentities.get(input.runnerId) }
  const verdict = await revalidateHandoff(input)
  if (!verdict.ok) {
    host.handoffDiag.record({
      stage: 'safety-boundary',
      outcome: 'rejected',
      reason: verdict.reason,
      op: input.operationId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
    await abandonHandoff(input.runnerId, verdict.reason, input.operationId)
    return
  }
  const cwd = state.cwd ?? ''
  const settings = await getSettings()
  const projectId = host.projectIdForCwd(settings, cwd)
  host.handoffDiag.record({
    stage: 'commit',
    outcome: 'started',
    op: input.handoffId,
    handoffId: input.handoffId,
    runnerId: input.runnerId,
    sessionKey: input.sessionKey,
    detail: { cwd, projectId: projectId ?? null }
  })
  try {
    const result = await handoffRunner.commit({
      handoffId: input.handoffId,
      sourceRunId: input.runnerId,
      sourceSession: input.sessionKey,
      cwd,
      ...(projectId ? { projectId } : {}),
      pkg: input.pkg,
      canContinue: () => {
        const op = handoffPending.get(input.runnerId)
        return !!op && op.request.operationId === input.operationId && !op.cancelled && !host.goals.isPaused(input.sessionKey)
      }
    })
    if (operation?.cancelled && operation.destinationRunId) {
      await host.goals.setPaused(host.workModeKeyFor(operation.destinationRunId), true)
      await host.cancelGoalResume(operation.destinationRunId)
    }
    if (!result.ok) {
      console.log(`[handoff] 交接停在 ${result.stage}：${result.error ?? ''}`)
      host.handoffDiag.record({
        stage: result.stage === 'committed' ? 'resume' : 'commit',
        outcome: result.stage === 'committed' ? 'unconfirmed' : 'halted',
        reason: result.error ?? result.stage,
        op: input.handoffId,
        handoffId: input.handoffId,
        runnerId: input.runnerId,
        sessionKey: input.sessionKey,
        detail: { stage: result.stage, destination: result.destinationSession ?? null }
      })
      return
    }
    host.handoffDiag.record({
      stage: 'commit',
      outcome: 'ok',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { stage: result.stage, destination: result.destinationSession ?? null }
    })
    host.handoffDiag.record({
      stage: 'resume',
      outcome: 'resume-confirmed',
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey,
      detail: { destination: result.destinationSession ?? null }
    })
  } catch (error) {
    console.error('[handoff] 交接执行失败：', error)
    host.handoffDiag.record({
      stage: 'commit',
      outcome: 'threw',
      reason: error instanceof Error ? error.message : String(error),
      op: input.handoffId,
      handoffId: input.handoffId,
      runnerId: input.runnerId,
      sessionKey: input.sessionKey
    })
  }
}

export async function inheritForHandoff(info: {
  sessionFile: string
  runId: string
  sourceSession: string
}): Promise<void> {
  const destKey = normalizeChainKey(info.sessionFile)
  const sourceKey = normalizeChainKey(info.sourceSession)
  if (!destKey || !sourceKey || sourceKey === destKey) return
  let modeInherited = false
  try {
    await host.workModes.load()
    const source = host.workModes.state(sourceKey, host.defaultWorkMode())
    if (!(source.revision === 0 && source.mode === host.defaultWorkMode())) {
      modeInherited = (await host.workModes.set(destKey, source.mode)).ok
    }
  } catch {
  }
  let goalInherited = false
  try {
    goalInherited = await host.goals.inheritTo(sourceKey, destKey)
  } catch {
  }
  try {
    const captureIdentity = () => {
      const runners = host.runners()
      const session = runners?.agentOf(info.runId)?.getState()
      return {
        id: info.runId,
        generation: runners?.runtimeOf(info.runId)?.generation,
        sessionId: session?.sessionId,
        sessionFile: session?.sessionFile
      }
    }
    const identity = captureIdentity()
    const key = host.workModeKeyFor(info.runId)
    const guard = () =>
      sameWorkModeIdentity(identity, captureIdentity()) && host.workModeKeyFor(info.runId) === key
    const state = await host.resolveWorkMode(info.runId)
    await host.workModes.load()
    const stored = host.workModes.state(key)
    const existing = await readWorkModeSnapshot(info.runId).catch(() => null)
    const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
    await writeWorkModeSnapshot(
      info.runId,
      {
        ...state,
        revision: stored.revision,
        questionFrequency: stored.questionFrequency,
        ...(existing?.planApprovalPending ? { planApprovalPending: true } : {})
      },
      undefined,
      {
        guard,
        owner: {
          ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
          ...(sessionFile ? { sessionFile } : {})
        }
      }
    )
    await host.applyGoalResume(info.runId)
  } catch {
  }
  host.handoffDiag.record({
    stage: 'resume',
    outcome: 'state-inherited',
    runnerId: info.runId,
    sessionKey: destKey,
    detail: { modeInherited, goalInherited, source: sourceKey }
  })
}
