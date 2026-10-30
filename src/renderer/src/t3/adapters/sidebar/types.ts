import type { ProjectRecord, SessionSummary } from '../../../../../shared/ipc'
import type { RunPhase, RunSnapshot } from '../../../../../shared/runs'
import { LOCAL_ENVIRONMENT_ID } from '../../internal/environment'
import type { EnvironmentThreadShell, ThreadRunSummary, ThreadRuntimeSummary } from '../../internal/models'
import { shortProject } from '../../../features/sidebar/sidebar-model'

export type ThreadRef = { environmentId: 'local'; threadId: string }
export type RowVariant = 'card' | 'slim' | 'folder' | 'folder-multiline'

export const NO_PROJECT_ID = '__none'

export interface SidebarThreadView extends EnvironmentThreadShell {
  readonly path: string
  readonly projectDisplayName: string | null
  readonly modelLabel: string | null
  readonly markedUnread: boolean
  readonly unread: boolean
  readonly activityAt: number
}

export interface SidebarProjectView {
  readonly projectKey: string
  readonly projectId: string
  readonly projectName: string
  readonly displayName: string
  readonly workspaceRoot: string
  readonly archived: boolean
}

export interface ThreadViewContext {
  readonly run: RunSnapshot | null
  readonly title: string
  readonly project: { readonly id: string; readonly label: string } | null
}

function iso(at: number | undefined): string | null {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : null
}

function requestKind(phase: RunPhase | null): { approval: boolean; input: boolean } {
  if (phase?.kind !== 'needs-you') return { approval: false, input: false }
  return { approval: phase.request.type === 'danger' || phase.request.type === 'confirm', input: !(phase.request.type === 'danger' || phase.request.type === 'confirm') }
}

function runtimeStatusOf(phase: RunPhase | null): ThreadRuntimeSummary['status'] | null {
  switch (phase?.kind) {
    case 'running':
      return 'running'
    case 'queued':
      return 'queued'
    case 'needs-you':
    case 'stalled':
      return 'waiting'
    case 'failed':
      return 'failed'
    case 'done':
    case 'stopped':
      return 'idle'
    default:
      return null
  }
}

function runStatusOf(phase: RunPhase | null): ThreadRunSummary['status'] {
  switch (phase?.kind) {
    case 'running':
    case 'queued':
      return 'running'
    case 'needs-you':
    case 'stalled':
      return 'waiting'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
    default:
      return 'completed'
  }
}

function phaseEndedAt(phase: RunPhase | null): number | null {
  if (!phase) return null
  if (phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'stopped') return phase.at
  return null
}

function runView(run: RunSnapshot | null): { latestRun: ThreadRunSummary | null; runtime: ThreadRuntimeSummary | null } {
  if (!run) return { latestRun: null, runtime: null }
  const status = runtimeStatusOf(run.phase)
  const endedAt = phaseEndedAt(run.phase)
  const latestRun: ThreadRunSummary = {
    runId: run.runId,
    status: runStatusOf(run.phase),
    requestedAt: iso(run.startedAt),
    startedAt: iso(run.startedAt),
    completedAt: iso(endedAt ?? undefined),
    assistantMessageId: null
  }
  const runtime: ThreadRuntimeSummary | null =
    status === null
      ? null
      : {
          status,
          activeRunId: endedAt === null ? run.runId : null,
          activityStartedAt: iso(run.startedAt),
          providerInstanceId: run.model?.provider ?? 'local',
          providerName: run.model?.provider ?? null,
          lastError: run.phase.kind === 'failed' ? run.phase.message : null,
          lastErrorClass: run.phase.kind === 'failed' && run.phase.errorKind === 'usage_limit' ? 'usage_limit' : null,
          lastErrorCode: run.phase.kind === 'failed' ? (run.phase.errorKind ?? null) : null,
          usageLimitResetAt: null,
          updatedAt: iso(endedAt ?? run.startedAt) ?? new Date(run.startedAt).toISOString()
        }
  return { latestRun, runtime }
}

export function toThreadView(item: SessionSummary, ctx: ThreadViewContext): SidebarThreadView {
  const phase = ctx.run?.phase ?? null
  const { latestRun, runtime } = runView(ctx.run)
  const requests = requestKind(phase)
  const activityAt = item.lastActivityAt ?? item.updatedAt
  const unreadRun = phase !== null && (phase.kind === 'done' || phase.kind === 'failed') && !phase.seen
  const provider = ctx.run?.model?.provider ?? null
  const model = ctx.run?.model
  return {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: item.id,
    projectId: ctx.project?.id ?? NO_PROJECT_ID,
    title: ctx.title,
    providerInstanceId: provider ?? 'local',
    modelSelection: model ? { instanceId: model.provider, model: `${model.provider}/${model.id}` } : null,
    runtimeMode: 'local',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    lineage: null,
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
    activeProviderThreadId: null,
    latestRun,
    runtime,
    blockedOnThreadWait: phase?.kind === 'stalled',
    latestUserMessageAt: iso(activityAt),
    latestUserAuthoredMessageAt: iso(activityAt),
    hasPendingApprovals: requests.approval,
    hasPendingUserInput: requests.input,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: item.messageCount,
    visibleItemCount: item.messageCount,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
    archivedAt: iso(item.archivedAt),
    settledOverride: null,
    settledAt: iso(item.archivedAt),
    unsettledAt: null,
    snoozedUntil: iso(item.snoozedUntil),
    snoozedAt: null,
    limitRecovery: null,
    pinnedAt: item.pinned ? new Date(item.lastOpenedAt ?? item.updatedAt).toISOString() : null,
    autoSettleDisabledAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    lastVisitedAt: iso(item.lastOpenedAt),
    opens: null,
    titleRegeneration: null,
    deletedAt: null,
    source: null,
    path: item.path,
    projectDisplayName: ctx.project?.label ?? null,
    modelLabel: model?.label ?? item.model ?? null,
    markedUnread: item.markedUnread === true,
    unread: item.markedUnread === true || unreadRun,
    activityAt
  }
}

export function toProjectView(record: ProjectRecord, projectNames: Record<string, string>): SidebarProjectView {
  const displayName = record.name || projectNames[record.cwd] || shortProject(record.cwd)
  return {
    projectKey: `${LOCAL_ENVIRONMENT_ID}:${record.id}`,
    projectId: record.id,
    projectName: record.name || displayName,
    displayName,
    workspaceRoot: record.cwd,
    archived: record.archived
  }
}

export function scopedKeyOf(threadId: string): string {
  return `${LOCAL_ENVIRONMENT_ID}:${threadId}`
}
