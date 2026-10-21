import type { RunModel } from '../../shared/runs'
import type { RunContext } from './registry'

export interface SubagentRunIdentity {
  id: string
  parentSessionId?: string
  task?: string
  model?: string
  thinkingLevel?: string
  activeSince?: number
}

export function subagentScopeId(id: string): string {
  return `subagent:${id}`
}

export function subagentModel(run: Pick<SubagentRunIdentity, 'model' | 'thinkingLevel'>): RunModel | undefined {
  const label = typeof run.model === 'string' ? run.model.trim() : ''
  if (!label) return undefined
  const slash = label.indexOf('/')
  const provider = slash > 0 ? label.slice(0, slash) : ''
  const id = slash > 0 ? label.slice(slash + 1) : label
  return { provider, id, label, ...(run.thinkingLevel ? { thinking: run.thinkingLevel } : {}) }
}

export function subagentRunContext(run: SubagentRunIdentity, extra: Partial<RunContext> = {}): RunContext | null {
  if (!run.id || !run.parentSessionId) return null
  const model = subagentModel(run)
  return {
    sessionId: subagentScopeId(run.id),
    kind: 'subagent',
    parentSessionId: run.parentSessionId,
    ...(run.task ? { title: run.task } : {}),
    ...(model ? { model } : {}),
    ...extra
  }
}
