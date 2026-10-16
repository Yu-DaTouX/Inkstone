import type { RunnerRegistry } from './runners'
import { readTurnTimings, timingKey } from './turn-timing-store'

import { GoalStore, writeGoalResumeSnapshot } from './goal-service'
import { isActiveGoalPhase } from '../shared/goal'
import type { BudgetUsage } from '../shared/goal'
import { YAN_DIR } from './paths'
import { adoptPendingWorkMode, normalizeSessionFileKey, pendingWorkModeKey, readWorkModeSnapshot, sameWorkModeIdentity, writeWorkModeSnapshot } from './work-mode-service'
import type { WorkModeIdentity } from './work-mode-service'
import { pendingAgentProfileKey } from './agent-profile-store'
import { DEFAULT_AGENT_PROFILE } from '../shared/agent-profile'
import type { AgentProfileState } from '../shared/agent-profile'
import type { AssembleContextRequest } from './context-assembler'
import { currentTaskPlan } from './task-plan-store'
import { DEFAULT_WORK_MODE } from '../shared/work-mode'
import type { WorkMode, WorkModeState } from '../shared/work-mode'
import type { WorkModeStore } from './work-mode-service'
import type { AgentProfileStore } from './agent-profile-store'
import type { SpaceStore } from './space-store'
import type { ContextAssembler } from './context-assembler'
import type { HandoffDiagnostics } from './handoff-diagnostics'
import type { MainPush } from '../shared/ipc'

export interface GoalHost {
  runners(): RunnerRegistry | null
  workModes: WorkModeStore
  agentProfiles: AgentProfileStore
  spaces: SpaceStore
  contextAssembler: ContextAssembler
  handoffDiag: HandoffDiagnostics
  pushFrom(runnerId: string, msg: MainPush): void
}

let host: GoalHost

export function configureGoalCoordinator(next: GoalHost): void {
  host = next
}

export function setDefaultWorkMode(mode: WorkMode): void {
  agentDefaultWorkMode = mode
}

export function defaultWorkMode(): WorkMode {
  return agentDefaultWorkMode
}

let agentDefaultWorkMode: WorkMode = DEFAULT_WORK_MODE

export async function goalBudgetUsage(id: string, startedAt: number): Promise<BudgetUsage | undefined> {
  const sessionFile = host.runners()?.agentOf(id)?.getState()?.sessionFile
  const bucket = timingKey(sessionFile)
  if (!bucket) return undefined
  const records = await readTurnTimings(YAN_DIR, bucket).catch(() => [])
  if (!records.length) return undefined
  const since = startedAt > 0 ? startedAt : 0
  const inGoal = records.filter((r) => (r.startedAt ?? 0) >= since)
  const reported = inGoal.filter((r) => typeof r.outputTokens === 'number')
  return {
    tokens: reported.length ? reported.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0) : null,
    elapsedMs: since > 0 ? Date.now() - since : 0
  }
}

export function workModeKeyFor(id: string): string {
  const file = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  return file ?? pendingWorkModeKey(id)
}

export async function resolveWorkMode(_id: string): Promise<WorkModeState> {
  return { mode: 'standard', revision: 0 }
}

export async function pushWorkMode(id: string): Promise<WorkModeState> {
  const state = await resolveWorkMode(id)
  await host.workModes.load()
  const session = host.runners()?.agentOf(id)?.getState()
  const identity: WorkModeIdentity = {
    id,
    generation: host.runners()?.runtimeOf?.(id)?.generation,
    sessionId: session?.sessionId,
    sessionFile: session?.sessionFile
  }
  const key = workModeKeyFor(id)
  await adoptPendingWorkMode(host.workModes, id, identity.sessionId, key)
  const stored = host.workModes.state(key)
  const existing = await readWorkModeSnapshot(id).catch(() => null)
  const payload: WorkModeState = {
    mode: state.mode,
    revision: stored.revision,
    questionFrequency: stored.questionFrequency
  }
  const guard = () => {
    const now = host.runners()?.agentOf(id)?.getState()
    return (
      sameWorkModeIdentity(identity, {
        id,
        generation: host.runners()?.runtimeOf?.(id)?.generation,
        sessionId: now?.sessionId,
        sessionFile: now?.sessionFile
      }) && workModeKeyFor(id) === key
    )
  }
  const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
  const committed = await writeWorkModeSnapshot(
    id,
    {
      ...payload,
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
  ).catch(() => false)
  if (committed && guard()) host.pushFrom(id, { ch: 'work-mode', payload })
  return payload
}

export const agentDefaultProfile = DEFAULT_AGENT_PROFILE

export function agentProfileKeyFor(id: string): string {
  const file = normalizeSessionFileKey(host.runners()?.agentOf(id)?.getState()?.sessionFile)
  return file ?? pendingAgentProfileKey(id)
}

export async function resolveAgentProfile(_id: string): Promise<AgentProfileState> {
  return { profile: 'auto', activity: 'answer', revision: 0 }
}

export async function pushAgentProfile(id: string): Promise<AgentProfileState> {
  const state = await resolveAgentProfile(id)
  host.pushFrom(id, { ch: 'agent-profile', payload: state })
  await refreshSessionContext(id, state)
  return state
}

export async function refreshSessionContext(_id: string, _state: AgentProfileState): Promise<void> {}

export async function buildContextRequest(id: string, state: AgentProfileState): Promise<AssembleContextRequest> {
  if (state.profile !== 'daily') return { activity: state.activity }

  const sessionId = host.runners()?.agentOf(id)?.getState()?.sessionId

  let task: string | undefined
  try {
    await goals.load()
    const goal = goals.state(workModeKeyFor(id))
    const parts: string[] = []
    if (goal.brief?.goal) parts.push(`目标：${goal.brief.goal}`)
    if (goal.brief?.outcome) parts.push(`达成判据：${goal.brief.outcome}`)
    if (goal.brief?.deliverable) parts.push(`交付物：${goal.brief.deliverable}`)
    if (goal.blocker) parts.push(`当前阻碍：${goal.blocker}`)
    if (sessionId) {
      const plan = await currentTaskPlan(sessionId).catch(() => null)
      const open = (plan?.state.todos ?? []).filter((t) => !t.done)
      if (open.length) parts.push(`待办：${open.slice(0, 5).map((t) => t.text).join('；')}`)
    }
    if (parts.length) task = parts.join('\n')
  } catch {
  }

  let space: string | undefined
  try {
    if (state.spaceId) {
      await host.spaces.load()
      const found = host.spaces.find(state.spaceId)
      if (found) space = found.description ? `${found.name}：${found.description}` : found.name
    }
  } catch {
  }

  return {
    activity: state.activity,
    ...(sessionId ? { sessionId } : {}),
    ...(task ? { task } : {}),
    ...(space ? { space } : {})
  }
}

export async function pushGoal(id: string): Promise<void> {
  await goals.load()
  const state = goals.state(workModeKeyFor(id))
  host.pushFrom(id, { ch: 'goal', payload: state })
  await refreshSessionContext(id, await resolveAgentProfile(id))
}

export async function applyGoalResume(_id: string): Promise<void> {}

export async function cancelGoalResume(id: string): Promise<void> {
  await goals.load()
  await goals.clearResume(workModeKeyFor(id)).catch(() => {})
  await writeGoalResumeSnapshot(id, null).catch(() => {})
}

export async function consumeRepeatBlocks(id: string): Promise<void> {
  const key = workModeKeyFor(id)
  const changed = await goals.consumeRepeatBlocks(id, key).catch((err: unknown) => {
    console.error('[goal] 重复动作计数计入失败签名失败：', err)
    host.handoffDiag.record({
      stage: 'goal-continue',
      outcome: 'repeat-guard-failed',
      reason: err instanceof Error ? err.message : String(err),
      runnerId: id,
      sessionKey: key
    })
    return false
  })
  if (!changed) return
  const goal = goals.state(key)
  console.log(
    `[goal] 重复动作被拦下已计入失败签名（会话 ${id}）：phase=${goal.phase} failure=${goal.failure?.count ?? 0}`
  )
  host.handoffDiag.record({
    stage: 'goal-continue',
    outcome: isActiveGoalPhase(goal.phase) ? 'repeat-counted' : 'blocked-by-repeat',
    runnerId: id,
    sessionKey: key,
    detail: { phase: goal.phase, failures: goal.failure?.count ?? 0 }
  })
  if (!isActiveGoalPhase(goal.phase)) await cancelGoalResume(id)
  host.pushFrom(id, { ch: 'goal', payload: goal })
}

export const goals = new GoalStore()

export const autonomousArmInFlight = new Set<string>()

export async function maybeArmGoalContinue(_id: string): Promise<void> {}
