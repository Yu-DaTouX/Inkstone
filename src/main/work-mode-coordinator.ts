import type { RunnerRegistry } from './runners'
import { adoptPendingWorkMode, normalizeSessionFileKey, pendingWorkModeKey, sameWorkModeIdentity, writeWorkModeSnapshot } from './work-mode-service'
import type { WorkModeIdentity, WorkModeStore } from './work-mode-service'
import { DEFAULT_WORK_MODE } from '../shared/work-mode'
import type { WorkMode, WorkModeState } from '../shared/work-mode'
import type { AgentProfileState } from '../shared/agent-profile'
import type { MainPush } from '../shared/ipc'

export interface WorkModeHost {
  runners(): RunnerRegistry | null
  workModes: WorkModeStore
  pushFrom(runnerId: string, msg: MainPush): void
}

let host: WorkModeHost
let agentDefaultWorkMode: WorkMode = DEFAULT_WORK_MODE

export function configureWorkModeCoordinator(next: WorkModeHost): void {
  host = next
}

export function setDefaultWorkMode(mode: WorkMode): void {
  agentDefaultWorkMode = mode
}

export function defaultWorkMode(): WorkMode {
  return agentDefaultWorkMode
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
  const committed = await writeWorkModeSnapshot(id, payload, undefined, {
    guard,
    owner: {
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(sessionFile ? { sessionFile } : {})
    }
  }).catch(() => false)
  if (committed && guard()) host.pushFrom(id, { ch: 'work-mode', payload })
  return payload
}

export async function resolveAgentProfile(_id: string): Promise<AgentProfileState> {
  return { profile: 'auto', activity: 'answer', revision: 0 }
}

export async function pushAgentProfile(id: string): Promise<AgentProfileState> {
  const state = await resolveAgentProfile(id)
  host.pushFrom(id, { ch: 'agent-profile', payload: state })
  return state
}
