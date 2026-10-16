import type { IpcRegistrar } from './registrar'
import {
  adoptPendingWorkMode,
  normalizeSessionFileKey,
  readWorkModeSnapshot,
  sameWorkModeIdentity,
  writeWorkModeSnapshot,
  type WorkModeStore
} from '../work-mode-service'
import {
  normalizeSessionQuestionFrequency,
  resolveQuestionFrequency,
  type QuestionFrequency,
  type SessionQuestionFrequency
} from '../../shared/question-frequency'
import type { RunnerRegistry } from '../runners'
import type { MainPush } from '../../shared/ipc'
import { DEFAULT_WORK_MODE, type WorkModeState } from '../../shared/work-mode'

export interface QuestionFrequencyIpcDeps {
  registry(): RunnerRegistry | null
  workModes: WorkModeStore
  workModeKeyFor(id: string): string
  globalQuestionFrequency(): Promise<QuestionFrequency>
  pushFrom(runnerId: string, msg: MainPush): void
}

export interface QuestionFrequencyView {
  runnerId: string
  sessionId?: string
  sessionFile?: string
  key: string
  revision: number
  preference: SessionQuestionFrequency
  effective: QuestionFrequency
  global: QuestionFrequency
}

interface ResolvedIdentity {
  id: string
  generation?: number
  sessionId?: string
  sessionFile?: string
}

function snapshotOwner(identity: ResolvedIdentity | null): { sessionId?: string; sessionFile?: string } {
  if (!identity) return {}
  const sessionFile = normalizeSessionFileKey(identity.sessionFile) ?? undefined
  return {
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {})
  }
}

export function registerQuestionFrequencyIpc(ipc: IpcRegistrar, deps: QuestionFrequencyIpcDeps): void {
  const { handle } = ipc
  const { registry, workModes, workModeKeyFor, globalQuestionFrequency, pushFrom } = deps

  function resolveIdentity(requestedRunnerId: unknown): ResolvedIdentity | null {
    const runners = registry()
    if (!runners) return null
    const requested =
      typeof requestedRunnerId === 'string' && requestedRunnerId.trim() ? requestedRunnerId.trim() : undefined
    const id = requested ?? runners.activeRunner()?.id
    if (!id) return null
    const agent = runners.agentOf(id)
    if (!agent) return null
    const state = agent.getState()
    if (!state) return null
    return { id, generation: runners.runtimeOf?.(id)?.generation, sessionId: state.sessionId, sessionFile: state.sessionFile }
  }

  async function describe(identity: ResolvedIdentity): Promise<QuestionFrequencyView> {
    await workModes.load()
    let current = resolveIdentity(identity.id) ?? identity
    let key = workModeKeyFor(current.id)
    await adoptPendingWorkMode(workModes, current.id, current.sessionId, key)
    let state = workModes.state(key)
    const global = await globalQuestionFrequency()
    const after = resolveIdentity(identity.id)
    if (after && !sameWorkModeIdentity(current, after)) {
      current = after
      key = workModeKeyFor(current.id)
      await adoptPendingWorkMode(workModes, current.id, current.sessionId, key)
      state = workModes.state(key)
    }
    const preference = normalizeSessionQuestionFrequency(state.questionFrequency)
    return {
      runnerId: current.id,
      sessionId: current.sessionId,
      sessionFile: current.sessionFile,
      key,
      revision: state.revision,
      preference,
      effective: resolveQuestionFrequency(preference, global),
      global
    }
  }

  async function publish(identity: ResolvedIdentity): Promise<WorkModeState | null> {
    const id = identity.id
    const key = workModeKeyFor(id)
    const guard = () => sameWorkModeIdentity(identity, resolveIdentity(id)) && workModeKeyFor(id) === key
    const existing = await readWorkModeSnapshot(id).catch(() => null)
    if (!guard()) return null
    const state = workModes.state(key)
    const payload: WorkModeState & { planApprovalPending?: boolean } = {
      mode: DEFAULT_WORK_MODE,
      revision: state.revision,
      questionFrequency: normalizeSessionQuestionFrequency(state.questionFrequency),
      ...(existing?.planApprovalPending ? { planApprovalPending: true } : {})
    }
    const committed = await writeWorkModeSnapshot(id, payload, undefined, {
      guard,
      owner: snapshotOwner(identity)
    }).catch(() => false)
    if (!committed || !guard()) return null
    pushFrom(id, { ch: 'work-mode', payload })
    return payload
  }

  handle('yan:getSessionQuestionFrequency', async (requestedRunnerId: unknown) => {
    const identity = resolveIdentity(requestedRunnerId)
    if (!identity) return { ok: false as const, error: 'no_session' as const }
    return { ok: true as const, ...(await describe(identity)) }
  })

  handle('yan:setSessionQuestionFrequency', async (input: unknown) => {
    const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const requestedRunnerId = typeof request.runnerId === 'string' ? request.runnerId.trim() : ''
    if (!requestedRunnerId) return { ok: false as const, error: 'no_session' as const }
    const identity = resolveIdentity(requestedRunnerId)
    if (!identity) return { ok: false as const, error: 'no_session' as const }

    const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : undefined
    const sessionFile = typeof request.sessionFile === 'string' && request.sessionFile ? request.sessionFile : undefined
    if (!sessionId && !sessionFile) return { ok: false as const, error: 'no_session' as const }

    const stale =
      (sessionId !== undefined && sessionId !== identity.sessionId) ||
      (sessionFile !== undefined && normalizeSessionFileKey(sessionFile) !== normalizeSessionFileKey(identity.sessionFile))
    if (stale) {
      return { ok: false as const, error: 'stale_session' as const, ...(await describe(identity)) }
    }

    const expectedRevision = request.expectedRevision
    if (typeof expectedRevision !== 'number' || !Number.isFinite(expectedRevision) || expectedRevision < 0) {
      return { ok: false as const, error: 'bad-revision' as const }
    }

    const key = workModeKeyFor(identity.id)
    const preference = normalizeSessionQuestionFrequency(request.questionFrequency)
    const owner = identity.sessionId

    await workModes.load()
    await adoptPendingWorkMode(workModes, identity.id, identity.sessionId, key)
    const res = await workModes.setQuestionFrequency(key, preference, expectedRevision, owner)

    const identityStable = sameWorkModeIdentity(identity, resolveIdentity(identity.id))

    if (!res.ok) {
      if (identityStable) await publish(identity)
      const current = workModes.state(key)
      const global = await globalQuestionFrequency()
      return {
        ok: false as const,
        error: res.error ?? 'version-mismatch',
        revision: current.revision,
        preference: normalizeSessionQuestionFrequency(current.questionFrequency),
        effective: resolveQuestionFrequency(current.questionFrequency, global),
        global
      }
    }

    if (!identityStable) {
      const global = await globalQuestionFrequency()
      return {
        ok: false as const,
        error: 'identity-changed' as const,
        revision: res.state.revision,
        preference: normalizeSessionQuestionFrequency(res.state.questionFrequency),
        effective: resolveQuestionFrequency(res.state.questionFrequency, global),
        global
      }
    }

    const payload = await publish(identity)
    if (!payload) return { ok: false as const, error: 'identity-changed' as const }
    const global = await globalQuestionFrequency()
    return {
      ok: true as const,
      runnerId: identity.id,
      sessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
      key,
      revision: payload.revision,
      preference: normalizeSessionQuestionFrequency(payload.questionFrequency),
      effective: resolveQuestionFrequency(payload.questionFrequency, global),
      global
    }
  })
}
