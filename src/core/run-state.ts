/** Executor facts used by the host; no messages, context policy or UI objects. */
export interface ExecutionState {
  sessionId?: string
  sessionFile?: string
  cwd?: string
  isAgentRunning?: boolean
  isCompacting?: boolean
  isStreaming?: boolean
}

/** Process-local identity. Persistent sessions remain owned by the executor. */
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

/** A compacting, streaming, shell-running or waiting executor cannot be reused. */
export function executionBusy(state: ExecutionState | null, hasRunningBash: () => boolean, pendingUiCount: () => number): boolean {
  if (state?.isAgentRunning === true || state?.isCompacting === true || state?.isStreaming === true) return true
  if (hasRunningBash()) return true
  return pendingUiCount() > 0
}

/** Pending identity must keep the same runId and generation once pi is ready. */
export function runEnvelope(run: RunIdentity, state: ExecutionState | null) {
  return {
    sessionId: state?.sessionId || `pending:${run.id}`,
    runId: run.id,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    generation: run.generation
  }
}

/** Read-only projection; connection exit does not assert task completion. */
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
