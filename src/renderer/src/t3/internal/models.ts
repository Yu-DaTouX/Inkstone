import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  PendingSubagentRequest,
  ProviderInstanceId,
  RunId
} from './contracts'

export interface ThreadRunSummary {
  readonly runId: RunId
  readonly status: OrchestrationV2RunStatus
  readonly requestedAt: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly assistantMessageId: MessageId | null
  readonly turnEnded?: boolean
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | 'idle'
  readonly activeRunId: RunId | null
  readonly activityStartedAt?: string | null
  readonly providerInstanceId: ProviderInstanceId
  readonly providerName: string | null
  readonly lastError: string | null
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null
  readonly lastErrorCode?: string | null
  readonly usageLimitResetAt?: string | null
  readonly updatedAt: string
}

export type ThreadStructureRuntime = Omit<ThreadRuntimeSummary, 'updatedAt'>

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting'
])

export function threadRuntimeIsActive(runtime: ThreadStructureRuntime | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && ACTIVE_RUN_STATUSES.has(runtime.status)
}

export function threadRuntimeCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  if (runtime?.status === 'queued') return runtime.activeRunId === null
  return runtime?.status !== 'preparing' && runtime?.status !== 'starting' && runtime?.status !== 'running'
}

export interface EnvironmentThreadShell {
  readonly environmentId: EnvironmentId
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly providerInstanceId: ProviderInstanceId
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string } | null
  readonly runtimeMode: 'local'
  readonly interactionMode: 'default' | 'plan'
  readonly branch: string | null
  readonly worktreePath: string | null
  readonly lineage: null
  readonly forkedFrom: null
  readonly linkOrigin: null
  readonly delegatedFrom: null
  readonly activeProviderThreadId: string | null
  readonly latestRun: ThreadRunSummary | null
  readonly runtime: ThreadRuntimeSummary | null
  readonly blockedOnThreadWait: boolean
  readonly latestUserMessageAt: string | null
  readonly latestUserAuthoredMessageAt: string | null
  readonly hasPendingApprovals: boolean
  readonly hasPendingUserInput: boolean
  readonly pendingSubagentRequest: PendingSubagentRequest | null
  readonly pendingGuestMessageCount: number
  readonly hasActionableProposedPlan: boolean
  readonly pendingBackgroundTasks: readonly never[]
  readonly providerInstanceHistory: readonly ProviderInstanceId[]
  readonly goal: null
  readonly itemCount: number
  readonly visibleItemCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt: string | null
  readonly settledOverride: null
  readonly settledAt: string | null
  readonly unsettledAt: null
  readonly snoozedUntil: string | null
  readonly snoozedAt: string | null
  readonly limitRecovery: null
  readonly pinnedAt: string | null
  readonly autoSettleDisabledAt: null
  readonly pinOrderKey: null
  readonly activeOrderKey: null
  readonly pullRequests: readonly never[]
  readonly linkedPullRequest: null
  readonly branchPullRequest: null
  readonly lastVisitedAt: string | null
  readonly opens: null
  readonly titleRegeneration: null
  readonly deletedAt: null
  readonly source: null
}

export function resolveThreadWorkingStartedAt(input: {
  readonly runtime: Pick<ThreadRuntimeSummary, 'status' | 'activityStartedAt'> | null
  readonly latestRun: Pick<ThreadRunSummary, 'startedAt'> | null
}): string | null {
  if (input.runtime !== null && ACTIVE_RUN_STATUSES.has(input.runtime.status)) {
    return input.runtime.activityStartedAt ?? input.latestRun?.startedAt ?? null
  }
  return input.latestRun?.startedAt ?? null
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
