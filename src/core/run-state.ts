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

/**
 * 两份运行时封套是否指向**同一次执行身份**。
 *
 * 用于快照异步采集：采集开始时捕获一份，读完之后再取一份，不一致就不能把旧
 * payload 贴到新封套上（F03）。判据按 runId + generation 归一，因为同代次里
 * `sessionId` 会从 `pending:<runId>` 过渡到真实 uuid —— 那是同一实例的正常迁移，
 * 不能当成过期；而两个不同的真实 sessionId 属于不同会话，必须判为不一致。
 */
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
