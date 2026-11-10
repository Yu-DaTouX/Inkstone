import { pick } from '../../shared/ui-lang'
import type { QuickAskResult, QuickAskSubmit } from './aux-types'
import { validateQuickAsk } from './aux-state'

export interface QuickAskAgentPort {
  send(text: string): Promise<{ ok: boolean; error?: string }>
  getState(): { sessionId?: string; sessionFile?: string } | null
}

export interface QuickAskPreviousSession {
  runId: string | null
  sessionId?: string
  sessionFile?: string
}

export interface QuickAskSubmitDeps {
  activeRunId(): string | null
  agentOf(runId: string): QuickAskAgentPort | null
  start(): Promise<{ ok: boolean; error?: string }>
  createSession(opts: { projectId?: string }): Promise<{ ok: boolean; error?: string; id?: string }>
  applyModel?(runId: string, model: { provider: string; id: string }): Promise<{ ok: boolean; error?: string }>
  abandonSession?(runId: string, previous: QuickAskPreviousSession): Promise<void>
}

export type QuickAskSessionTarget = { ok: true; cwd: string; projectId?: string } | { ok: false; error: string }

export function quickAskSessionTarget(
  settings: { cwd: string; projects: readonly { id: string; cwd: string; archived?: boolean }[] },
  projectId?: string
): QuickAskSessionTarget {
  if (!projectId) return { ok: true, cwd: settings.cwd }
  const project = settings.projects.find((item) => item.id === projectId && !item.archived)
  if (!project) return { ok: false, error: pick('找不到所选项目，可能已被移除或归档', 'Selected project not found; it may have been removed or archived') }
  return { ok: true, cwd: project.cwd, projectId: project.id }
}

export async function submitQuickAsk(deps: QuickAskSubmitDeps, payload: QuickAskSubmit): Promise<QuickAskResult> {
  const hasCurrent = deps.activeRunId() !== null
  const invalid = validateQuickAsk(payload.prompt, payload.target, hasCurrent)
  if (invalid) return { ok: false, code: invalid }

  const previousRunId = deps.activeRunId()
  const previousState = previousRunId ? deps.agentOf(previousRunId)?.getState() ?? null : null
  const previous: QuickAskPreviousSession = {
    runId: previousRunId,
    ...(previousState?.sessionId ? { sessionId: previousState.sessionId } : {}),
    ...(previousState?.sessionFile ? { sessionFile: previousState.sessionFile } : {})
  }

  let runId: string | null = null
  let created = false
  if (payload.target === 'new') {
    const started = await deps.start()
    if (!started.ok) return { ok: false, code: 'start-failed', message: started.error }
    const session = await deps.createSession({
      ...(payload.projectId ? { projectId: payload.projectId } : {})
    })
    if (!session.ok || !session.id) return { ok: false, code: 'create-failed', message: session.error }
    runId = session.id
    created = true
  } else {
    runId = deps.activeRunId()
  }

  const agent = runId ? deps.agentOf(runId) : null
  const abandonCreated = async (): Promise<void> => {
    if (!created || !runId || !deps.abandonSession) return
    await deps.abandonSession(runId, previous).catch(() => undefined)
  }
  if (!agent || !runId) {
    await abandonCreated()
    return { ok: false, code: 'unavailable' }
  }

  if (payload.model) {
    if (!deps.applyModel) {
      await abandonCreated()
      return { ok: false, code: 'model-failed' }
    }
    const applied = await deps.applyModel(runId, payload.model)
    if (!applied.ok) {
      await abandonCreated()
      return { ok: false, code: 'model-failed', message: applied.error }
    }
  }

  const sent = await agent.send(payload.prompt.trim())
  if (!sent.ok) {
    await abandonCreated()
    return { ok: false, code: 'send-failed', message: sent.error }
  }
  const state = agent.getState()
  return {
    ok: true,
    runId,
    ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state?.sessionFile ? { sessionPath: state.sessionFile } : {})
  }
}
