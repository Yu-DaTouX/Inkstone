import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { localDeviceId, markConsentAuto, readConsentLedger, recordConsentAnswer } from '../consent-store'
import type { ApprovalOwner } from '../../shared/approval'
import {
  consentFeedbackSummary,
  consentKeyOf,
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
  const normalized = normalizeConsentParts(params, localDeviceId(), 'local')
  if (!normalized.ok) throw new CapabilityCommandError('consent_bad_request', normalized.error)
  const parts = normalized.parts
  const purpose = typeof params.purpose === 'string' ? params.purpose.trim().slice(0, 500) : ''
  const declaredDanger = params.dangerous === true || params.dangerous === 'true'
  if ((!declaredDanger && !dangerCategoryOf(parts)) || (await host.permissionMode()) === 'all') {
    return { summary: { kind: 'consent', allowed: true, decision: 'auto', reason: 'permission-mode' } }
  }
  const ledger = await readConsentLedger()
  const verdict = consentVerdict(ledger.entries.find((entry) => entry.key === consentKeyOf(parts)), parts, Date.now())
  const summary = (decision: 'auto' | ConsentDecision | 'no-answer') => ({
    kind: 'consent',
    capability: parts.capability,
    action: parts.action,
    resource: parts.resource,
    decision,
    allowed: decision === 'auto' || decision === 'allow',
    reason: verdict.reason
  })
  if (verdict.mode === 'auto') {
    await markConsentAuto(parts).catch(() => undefined)
    return { data: { verdict }, summary: summary('auto') }
  }
  const answer = await host.confirmToolConsent({ parts, purpose, verdict, cwd: host.cwd(), owner: host.approvalOwner() })
  if (!answer) return { data: { verdict }, summary: summary('no-answer') }
  await recordConsentAnswer(parts, answer.decision)
  return { data: { verdict }, summary: { ...summary(answer.decision), ...consentFeedbackSummary(answer.decision, answer.feedback) } }
}
