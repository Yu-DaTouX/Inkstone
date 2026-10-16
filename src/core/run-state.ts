export interface ExecutionState {
  sessionId?: string
  sessionFile?: string
  cwd?: string
  isAgentRunning?: boolean
  isCompacting?: boolean
  isStreaming?: boolean
}

export interface RunIdentity {
  id: string
  projectId?: string
  generation: number
}

export interface RunObservation extends RunIdentity {
  cwd: string
  createdAt: number
  lastActiveAt: number
  state: ExecutionState | null
  pendingUiCount: number
  conn: 'starting' | 'ready' | 'exited' | 'error'
  isActive: boolean
  isolation?: { state: 'waiting' | 'blocked'; branch: string }
}

export function executionBusy(state: ExecutionState | null, hasRunningBash: () => boolean, pendingUiCount: () => number): boolean {
  if (state?.isAgentRunning === true || state?.isCompacting === true || state?.isStreaming === true) return true
  if (hasRunningBash()) return true
  return pendingUiCount() > 0
}

export function sameRuntimeEnvelope(
  a: { sessionId?: string; runId?: string; generation?: number } | null | undefined,
  b: { sessionId?: string; runId?: string; generation?: number } | null | undefined
): boolean {
  if (!a || !b) return false
  if (a.runId !== b.runId || a.generation !== b.generation) return false
  if (a.sessionId === b.sessionId) return true
  const pending = (value?: string) => !value || value.startsWith('pending:')
  return pending(a.sessionId) || pending(b.sessionId)
}

export function runEnvelope(run: RunIdentity, state: ExecutionState | null) {
  return {
    sessionId: state?.sessionId || `pending:${run.id}`,
    runId: run.id,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    generation: run.generation
  }
}

export function runStatus(run: RunObservation) {
  return {
    id: run.id,
    runId: run.id,
    sessionFile: run.state?.sessionFile,
    sessionId: run.state?.sessionId,
    projectId: run.projectId,
    generation: run.generation,
    cwd: run.state?.cwd ?? run.cwd,
    running: run.state?.isAgentRunning === true,
    waiting: run.pendingUiCount > 0,
    failed: run.conn === 'error' || run.conn === 'exited',
    conn: run.conn,
    createdAt: run.createdAt,
    lastActiveAt: run.lastActiveAt,
    isActive: run.isActive,
    ...(run.isolation ? { isolation: run.isolation.state, isolationBranch: run.isolation.branch } : {})
  }
}
