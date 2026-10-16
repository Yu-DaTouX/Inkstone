import type { QuickAskResult, QuickAskSubmit } from './aux-types'
import { validateQuickAsk } from './aux-state'

export interface QuickAskAgentPort {
  send(text: string): Promise<{ ok: boolean; error?: string }>
  getState(): { sessionId?: string; sessionFile?: string } | null
}

export interface QuickAskSubmitDeps {
  activeRunId(): string | null
  agentOf(runId: string): QuickAskAgentPort | null
  start(): Promise<{ ok: boolean; error?: string }>
  createSession(opts: { projectId?: string }): Promise<{ ok: boolean; error?: string; id?: string }>
  applyModel?(runId: string, model: { provider: string; id: string }): Promise<{ ok: boolean; error?: string }>
}

export async function submitQuickAsk(deps: QuickAskSubmitDeps, payload: QuickAskSubmit): Promise<QuickAskResult> {
  const hasCurrent = deps.activeRunId() !== null
  const invalid = validateQuickAsk(payload.prompt, payload.target, hasCurrent)
  if (invalid) return { ok: false, code: invalid }

  let runId: string | null = null
  if (payload.target === 'new') {
    const started = await deps.start()
    if (!started.ok) return { ok: false, code: 'start-failed', message: started.error }
    const created = await deps.createSession({
      ...(payload.projectId ? { projectId: payload.projectId } : {})
    })
    if (!created.ok || !created.id) return { ok: false, code: 'create-failed', message: created.error }
    runId = created.id
  } else {
    runId = deps.activeRunId()
  }

  const agent = runId ? deps.agentOf(runId) : null
  if (!agent || !runId) return { ok: false, code: 'unavailable' }

  if (payload.model) {
    if (!deps.applyModel) return { ok: false, code: 'model-failed' }
    const applied = await deps.applyModel(runId, payload.model)
    if (!applied.ok) return { ok: false, code: 'model-failed', message: applied.error }
  }

  const sent = await agent.send(payload.prompt.trim())
  if (!sent.ok) return { ok: false, code: 'send-failed', message: sent.error }
  const state = agent.getState()
  return {
    ok: true,
    runId,
    ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state?.sessionFile ? { sessionPath: state.sessionFile } : {})
  }
}
