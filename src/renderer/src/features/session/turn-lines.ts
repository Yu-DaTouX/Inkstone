import type { CompactionRun, SessionSummary, SubagentRun, UIMessage } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import { isTerminalPhase } from '../../../../shared/runs'
import { subagentOutcome, type SubagentOutcomeKey, type SubagentTone } from '../../../../shared/subagent-outcome'
import { classifyModelError, type ModelErrorKind, type ModelErrorQuotaScope } from '../../../../shared/model-errors'
import { sameSessionFile } from '../../state/view-identity'
import type { SessionTextKey } from './text'

export type ErrorCardAction = 'retry' | 'model' | 'compact'

export interface ErrorCardModel {
  kind: ModelErrorKind
  quotaScope?: ModelErrorQuotaScope
  actions: ErrorCardAction[]
  body: string
}

function classifiableErrorText(body: string): string {
  const marker = '原因：'
  const at = body.lastIndexOf(marker)
  return at >= 0 ? body.slice(at + marker.length).trim() || body : body
}

export function errorCardModel(errorText: string | undefined | null): ErrorCardModel | null {
  const body = (errorText ?? '').trim()
  if (!body) return null
  const info = classifyModelError(classifiableErrorText(body))
  const actions: ErrorCardAction[] = []
  switch (info.kind) {
    case 'context':
      actions.push('compact')
      break
    case 'retryable':
      actions.push('retry', 'model')
      break
    case 'quota':
      if (info.quotaScope === 'rate') actions.push('retry')
      actions.push('model')
      break
    case 'auth':
    case 'refused':
    case 'request':
      actions.push('model')
      break
    default:
      break
  }
  return {
    kind: info.kind,
    ...(info.quotaScope ? { quotaScope: info.quotaScope } : {}),
    actions,
    body
  }
}

export function errorTitleKey(model: ErrorCardModel): SessionTextKey {
  if (model.kind === 'quota') return model.quotaScope === 'rate' ? 'errorTitleQuotaRate' : 'errorTitleQuotaUsage'
  const map: Record<ModelErrorKind, SessionTextKey> = {
    retryable: 'errorTitleRetryable',
    quota: 'errorTitleQuotaUsage',
    auth: 'errorTitleAuth',
    context: 'errorTitleContext',
    aborted: 'errorTitleAborted',
    refused: 'errorTitleRefused',
    request: 'errorTitleRequest'
  }
  return map[model.kind]
}

export function promptForTurn(
  sourceIds: readonly string[],
  messages: readonly UIMessage[]
): { text: string; images: { data: string; mimeType: string }[] } | null {
  const firstId = sourceIds[0]
  if (!firstId) return null
  const start = messages.findIndex((message) => message.id === firstId)
  if (start < 0) return null
  for (let i = start - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' || !message.text) continue
    const images = (message.images ?? [])
      .filter((image) => !!image.data)
      .map((image) => ({ data: image.data as string, mimeType: image.mimeType }))
    return { text: message.text, images }
  }
  return null
}

export interface CompactionLineModel {
  run: CompactionRun
  running: boolean
}

export function compactionLineModel(
  running: CompactionRun | undefined,
  last: CompactionRun | undefined
): CompactionLineModel | null {
  if (running) return { run: running, running: true }
  if (last) return { run: last, running: false }
  return null
}

export function branchOriginOf(
  sessions: readonly SessionSummary[],
  view: { sessionId: string | null; sessionFile: string | null }
): string | null {
  if (view.sessionId) {
    const byId = sessions.find((item) => item.id === view.sessionId)
    if (byId) return byId.branchOrigin?.trim() || null
  }
  if (view.sessionFile) {
    const byPath = sessions.find((item) => sameSessionFile(item.path, view.sessionFile))
    if (byPath) return byPath.branchOrigin?.trim() || null
  }
  return null
}

export function messageEntrySignature(messages: readonly UIMessage[]): string {
  let signature = ''
  for (const message of messages) {
    if (!message.entryId) continue
    signature += `${signature ? '\u0001' : ''}${message.entryId}`
  }
  return signature
}

export interface ViewEdge {
  first: boolean
  last: boolean
}

export function viewEdge(sourceIds: readonly string[], messages: readonly UIMessage[], streaming: boolean): ViewEdge {
  if (!sourceIds.length) return { first: false, last: false }
  const firstAssistant = messages.find((message) => message.role === 'assistant')
  const lastMessage = messages[messages.length - 1]
  return {
    first: firstAssistant?.id === sourceIds[0],
    last: !!streaming || (!!lastMessage && sourceIds.includes(lastMessage.id))
  }
}

export interface SubagentLineModel {
  id: string
  code: string | null
  task: string
  model: string | null
  isolation: SubagentRun['isolation']
  outcomeKey: SubagentOutcomeKey
  outcomeTone: SubagentTone
  phase: RunSnapshot['phase'] | null
  live: boolean
  attention: boolean
  terminal: boolean
  elapsedMs: number
  latest: string | null
  error: string | null
  recovery: SubagentRecoveryNote | null
  summary: string | null
  summaryTruncated: boolean
  diff: { files: number; additions: number; deletions: number } | null
  sources: string[]
  artifacts: string[]
  review: SubagentRun['review']
}

export type SubagentRecoveryNote =
  | { key: 'subagentResumed' | 'subagentNotRetried' }
  | { key: 'subagentRetried'; n: number }

export function subagentRecoveryNote(run: Pick<SubagentRun, 'endReason' | 'recovery'>): SubagentRecoveryNote | null {
  if (run.endReason !== 'model-error') return null
  if (run.recovery?.resumed) return { key: 'subagentResumed' }
  if (run.recovery?.piRetries) return { key: 'subagentRetried', n: run.recovery.piRetries }
  return { key: 'subagentNotRetried' }
}

export function subagentLineModel(run: SubagentRun, snapshot: RunSnapshot | undefined, now: number): SubagentLineModel {
  const outcome = subagentOutcome(run)
  const phase = snapshot?.phase ?? null
  const terminal = phase ? isTerminalPhase(phase) : !outcome.live
  const terminalAt = phase && (phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'stopped') ? phase.at : undefined
  const endedAt = run.endedAt ?? terminalAt
  const elapsedMs = Math.max(0, (endedAt ?? now) - run.startedAt)
  const model = snapshot?.model
    ? [snapshot.model.label || snapshot.model.id, snapshot.model.thinking].filter(Boolean).join(' · ')
    : run.model ?? null
  const result = run.result
  const summary = result?.summary?.trim() ? result.summary : null
  const diff = run.diff && run.diff.files > 0
    ? { files: run.diff.files, additions: run.diff.additions, deletions: run.diff.deletions }
    : null
  return {
    id: run.id,
    code: snapshot?.code ?? null,
    task: run.brief?.goal?.trim() || run.task,
    model,
    isolation: run.isolation,
    outcomeKey: outcome.key,
    outcomeTone: outcome.tone,
    phase,
    live: phase ? !isTerminalPhase(phase) : outcome.live,
    attention: outcome.attention,
    terminal,
    elapsedMs,
    latest: run.latestActivity?.trim() || null,
    error: run.error?.trim() || null,
    recovery: subagentRecoveryNote(run),
    summary,
    summaryTruncated: !!result?.summaryTruncated,
    diff,
    sources: result?.sources ?? [],
    artifacts: result?.artifacts ?? [],
    review: run.review
  }
}

export function findSubagentSnapshot(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
  return runs.find((run) => run.kind === 'subagent' && run.runId === runId)
}
