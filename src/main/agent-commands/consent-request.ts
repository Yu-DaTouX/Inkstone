import { hostname } from 'node:os'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import type { ApprovalOwner } from '../../shared/approval'
import {
  consentFeedbackSummary,
  consentVerdict,
  dangerCategoryOf,
  normalizeConsentParts,
  type ConsentAnswer,
  type ConsentDecision
} from '../../shared/tool-consent'
import type { ToolConsentPrompt } from '../agent'

export interface ConsentRequestHost {
  cwd(): string
  permissionMode(): Promise<'danger' | 'all' | undefined>
  confirmToolConsent(request: ToolConsentPrompt): Promise<ConsentAnswer | null>
  approvalOwner(): ApprovalOwner
}

export async function runConsentRequestCommand(host: ConsentRequestHost, params: Record<string, unknown>): Promise<CapabilityCommandResult> {
  const normalized = normalizeConsentParts(params, `host:${hostname().toLowerCase()}`, 'local')
  if (!normalized.ok) throw new CapabilityCommandError('consent_bad_request', normalized.error)
  const parts = normalized.parts
  const purpose = typeof params.purpose === 'string' ? params.purpose.trim().slice(0, 500) : ''
  const declaredDanger = params.dangerous === true || params.dangerous === 'true'
  if ((!declaredDanger && !dangerCategoryOf(parts)) || (await host.permissionMode()) === 'all') {
    return { summary: { kind: 'consent', allowed: true, decision: 'auto', reason: 'permission-mode' } }
  }
  const verdict = consentVerdict(parts)
  const summary = (decision: ConsentDecision | 'no-answer') => ({
    kind: 'consent',
    capability: parts.capability,
    action: parts.action,
    resource: parts.resource,
    decision,
    allowed: decision === 'allow',
    reason: verdict.reason
  })
  const answer = await host.confirmToolConsent({ parts, purpose, verdict, cwd: host.cwd(), owner: host.approvalOwner() })
  if (!answer) return { data: { verdict }, summary: summary('no-answer') }
  return { data: { verdict }, summary: { ...summary(answer.decision), ...consentFeedbackSummary(answer.decision, answer.feedback) } }
}
