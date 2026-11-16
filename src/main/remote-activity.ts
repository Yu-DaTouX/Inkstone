import { pick } from '../shared/ui-lang'
import { accountCardTitle, type AccountQuotaReport } from '../shared/account-quota'
import { isLiveTerminalJob, terminalJobOwnedBy, type TerminalJob } from '../shared/terminal-jobs'
import type { UsageStatsView } from '../shared/usage-stats'
import type { WorkflowRunView } from '../shared/workflows'
import type { RemoteJob, RemoteNotice, RemoteQuota, RemoteUsage, RemoteWorkflow, RemoteWorkflowProgress } from '../shared/remote-protocol'
import { redactSecretText } from '../shared/redact-diagnostic'
import { redactCommandSecrets } from '../shared/command-redact'
import { scrubRemoteError, type RemoteOperationResult } from './remote-server'

const NOTICE_MAX = 300
const JOBS_MAX = 20
const JOB_OUTPUT_MAX = 4000
const JOB_OUTPUTS = 5
const WORKFLOW_LOGS = 5
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

function maskEmail(text: string): string {
  return text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2')
}

export function remoteSafeText(text: string): string {
  return maskEmail(scrubRemoteError(redactCommandSecrets(redactSecretText(text))))
}

export function createQuotaCache<T>(load: () => Promise<T>, ttlMs = 45_000, now: () => number = Date.now): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.value
    const value = load()
    const entry = { at: now(), value }
    cached = entry
    value.catch(() => { if (cached === entry) cached = null })
    return value
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function remoteNoticeOf(payload: unknown, runtime?: unknown): RemoteNotice | null {
  const box = record(payload)
  if (typeof box.message !== 'string' || !box.message.trim()) return null
  const level = box.notifyType === 'error' || box.notifyType === 'warning' || box.notifyType === 'success' ? box.notifyType : 'info'
  const sessionId = typeof box.sessionId === 'string' ? box.sessionId : typeof record(runtime).sessionId === 'string' ? record(runtime).sessionId as string : undefined
  return {
    id: typeof box.id === 'string' && box.id ? box.id.slice(0, 120) : `notice-${Date.now()}`,
    level,
    message: clip(remoteSafeText(box.message.trim()), NOTICE_MAX),
    ...(sessionId ? { sessionId } : {})
  }
}

export function terminalOutputTail(buffer: string | null | undefined): { output: string; truncated: boolean } | null {
  if (!buffer) return null
  const plain = buffer.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (!plain) return null
  const safe = remoteSafeText(plain)
  return safe.length > JOB_OUTPUT_MAX ? { output: safe.slice(-JOB_OUTPUT_MAX), truncated: true } : { output: safe, truncated: false }
}

export function remoteJobsFor(keys: readonly string[], jobs: readonly TerminalJob[], read: (terminalId: string) => string | null): RemoteJob[] {
  const own = jobs.filter((job) => keys.some((key) => terminalJobOwnedBy(job, key)))
    .sort((a, b) => Number(isLiveTerminalJob(b)) - Number(isLiveTerminalJob(a)) || b.startedAt - a.startedAt)
    .slice(0, JOBS_MAX)
  return own.map((job, index) => {
    const tail = index < JOB_OUTPUTS && job.terminalId ? terminalOutputTail(read(job.terminalId)) : null
    return {
      id: job.id,
      command: clip(remoteSafeText(job.command), 400),
      state: job.state,
      live: isLiveTerminalJob(job),
      ...(job.kind ? { kind: job.kind } : {}),
      startedAt: job.startedAt,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(tail ? { output: tail.output, outputTruncated: tail.truncated } : {})
    }
  })
}

function workflowProgress(view: WorkflowRunView): RemoteWorkflowProgress {
  const stats = view.models
  if (stats) return { total: stats.total, done: stats.done + stats.cached, failed: stats.failed, running: stats.running, queued: stats.queued, stopped: stats.stopped }
  const count = (status: string) => view.agents.filter((agent) => agent.status === status).length
  return { total: view.agents.length, done: count('done') + count('cached'), failed: count('failed'), running: count('running'), queued: count('queued'), stopped: count('stopped') }
}

export function remoteWorkflowOf(view: WorkflowRunView): RemoteWorkflow {
  return {
    id: view.id,
    name: clip(view.name, 120),
    description: clip(view.description, 300),
    status: view.status,
    startedAt: view.startedAt,
    ...(view.endedAt !== undefined ? { endedAt: view.endedAt } : {}),
    attempt: view.attempt,
    progress: workflowProgress(view),
    ...(view.models?.waitingQuota ? { waitingQuota: true } : {}),
    ...(typeof view.models?.cost === 'number' ? { cost: view.models.cost } : {}),
    ...(view.error ? { error: clip(remoteSafeText(view.error), 600) } : {}),
    logs: view.logs.slice(-WORKFLOW_LOGS).map((line) => clip(remoteSafeText(line), 300)),
    canPause: view.status === 'running',
    canResume: view.status === 'paused',
    canStop: view.status === 'running' || view.status === 'paused'
  }
}

export function remoteWorkflowsFor(sessionId: string, views: readonly WorkflowRunView[]): RemoteWorkflow[] {
  return views.filter((view) => view.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 10).map(remoteWorkflowOf)
}

export async function remoteWorkflowControl(
  sessionId: string,
  id: string,
  action: 'pause' | 'resume' | 'stop',
  views: readonly WorkflowRunView[],
  control: (id: string, action: 'pause' | 'resume' | 'stop') => Promise<{ ok: boolean; error?: string }>
): Promise<RemoteOperationResult> {
  const view = views.find((item) => item.id === id && item.sessionId === sessionId)
  if (!view) return { ok: false, status: 404, error: pick('找不到这个工作流', 'Workflow not found') }
  const shown = remoteWorkflowOf(view)
  const allowed = action === 'pause' ? shown.canPause : action === 'resume' ? shown.canResume : shown.canStop
  if (!allowed) return { ok: false, status: 409, code: 'workflow_state', error: pick('工作流状态已变化，请刷新后再试', 'The workflow state changed. Refresh and try again') }
  const result = await control(view.id, action)
  return result.ok ? { ok: true, data: { id: view.id, action } } : { ok: false, status: 409, error: result.error ?? pick('工作流操作失败', 'Workflow action failed') }
}

export function remoteQuotaOf(report: AccountQuotaReport): RemoteQuota {
  return {
    checkedAt: report.checkedAt,
    cards: report.cards.slice(0, 30).map((card, index) => ({
      key: `card-${index}`,
      title: clip(remoteSafeText(accountCardTitle(card)), 120),
      provider: card.provider,
      ...(card.plan ? { plan: clip(card.plan, 60) } : {}),
      ...(card.active ? { active: true } : {}),
      status: card.status,
      windows: card.windows.filter((window) => !window.informational).slice(0, 6).map((window) => ({
        label: clip(window.label, 60),
        used: window.used,
        total: window.total,
        ...(window.resetAt ? { resetAt: window.resetAt } : {}),
        ...(window.exceeded ? { exceeded: true } : {})
      })),
      ...(card.balance ? { balance: card.balance } : {}),
      ...(card.error || card.staleError ? { error: clip(remoteSafeText(card.error ?? card.staleError ?? ''), 300) } : {})
    }))
  }
}

export function remoteUsageOf(view: UsageStatsView): RemoteUsage {
  return {
    range: view.range,
    sessions: view.sessions,
    messages: view.messages,
    tokens: view.tokens,
    cost: view.cost,
    activeDays: view.activeDays,
    models: view.models.slice(0, 5).map((model) => ({ name: clip(model.key.slice(model.key.lastIndexOf('/') + 1), 80), tokens: model.tokens, cost: model.cost }))
  }
}
