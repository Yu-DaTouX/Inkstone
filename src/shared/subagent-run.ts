import type { SubagentBrief, SubagentResult } from './subagent-brief'
import type { SessionContextUsage, UIMessage } from './ui-message'

export type SubagentReviewState = 'none' | 'pending' | 'conflict' | 'merged' | 'discarded' | 'archived'

export interface SubagentDiffSummary {
  files: number
  additions: number
  deletions: number
  paths: string[]
  truncated: boolean
  patchPath?: string
  skippedLinks?: string[]
  skippedLinkCount?: number
}

export interface SubagentUsageTotals {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  totalTokens: number | null
  cost: number | null
  reportedMessages: number
}

export type SubagentEndReason = 'completed' | 'timeout' | 'budget' | 'model-error' | 'startup' | 'exited' | 'failed' | 'stopped' | 'interrupted'

export interface SubagentStopResult {
  ok: boolean
  error?: string
  noop?: boolean
  before?: SubagentRun['status']
}

export interface SubagentRun {
  id: string
  task: string
  followUp?: string
  quotaWait?: SubagentQuotaWait
  cwd: string
  parentSessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  parentMessageIds?: string[]
  projectId?: string
  isolation: 'worktree' | 'controlled-cwd' | 'shared-cwd'
  fork?: boolean
  sideQuestion?: boolean
  resultPath?: string
  savedOutputsPath?: string
  pendingOutputs?: { path: string; files: string[] }
  model?: string
  modelPinned?: boolean
  thinkingLevel?: string
  contextUsage?: SessionContextUsage
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  latestActivity?: string
  progressWarning?: string
  transcript: UIMessage[]
  transcriptOmitted?: boolean
  diff?: SubagentDiffSummary
  review: SubagentReviewState
  error?: string
  endReason?: SubagentEndReason
  launchFailed?: boolean
  dismissedAt?: number
  toolCalls?: number
  wrapUp?: { reason: 'timeout' | 'budget'; since: number }
  recovery?: SubagentRecovery
  usage?: SubagentUsageTotals
  brief?: SubagentBrief
  result?: SubagentResult
  resumable?: { ok: boolean; reason?: string }
}

export interface SubagentQuotaWait {
  since: number
  resetAt?: number
  accounts: number
  needsAccount?: boolean
}

export function subagentQuotaProvider(model: string | undefined): string | undefined {
  const slash = model?.indexOf('/') ?? -1
  return slash > 0 ? model?.slice(0, slash).trim().toLowerCase() || undefined : undefined
}

export function subagentQuotaAttentionProviders(runs: readonly Pick<SubagentRun, 'model' | 'status' | 'quotaWait'>[]): Set<string> {
  const providers = new Set<string>()
  for (const run of runs) {
    if (run.status !== 'running' || !run.quotaWait?.needsAccount) continue
    const provider = subagentQuotaProvider(run.model)
    if (provider) providers.add(provider)
  }
  return providers
}

export interface SubagentRecovery {
  piRetries?: number
  piMaxRetries?: number
  resumed?: boolean
}
