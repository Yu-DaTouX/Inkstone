import { threadRuntimeIsActive, type EnvironmentThreadShell } from './models'

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | 'hasActionableProposedPlan'
  | 'hasPendingApprovals'
  | 'hasPendingUserInput'
  | 'pendingSubagentRequest'
  | 'interactionMode'
  | 'latestRun'
  | 'runtime'
>

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false
  if (thread.pendingSubagentRequest !== null) return false
  if (!threadRuntimeIsActive(thread.runtime)) return false
  const run = thread.latestRun
  const runSettled =
    run !== null &&
    run.status !== 'preparing' &&
    run.status !== 'queued' &&
    run.status !== 'starting' &&
    run.status !== 'running' &&
    run.status !== 'waiting' &&
    thread.runtime?.activeRunId !== run.runId
  return !(thread.interactionMode === 'plan' && thread.hasActionableProposedPlan && runSettled)
}
