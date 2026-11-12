import { useState, type JSX } from 'react'
import { claimFreshArrival } from '../../ui/motion-hooks'
import type { ApprovalChoice, ApprovalReceipt as ApprovalReceiptRecord } from '../../../../shared/approval'
import { Card, CardHead, CardMeta, CardStatus, CardTime, CardTitle, type CardStatusTone } from '../../ui/Card'
import { Icon } from './Icon'
import { useI18n } from '../../i18n'
import { localizeApprovalText } from './approval-reason-text'
import { useSessionText, type SessionTextKey } from './text'
import './approval.css'

const RECEIPT_STATUS: Record<ApprovalChoice, { tone: CardStatusTone; key: SessionTextKey; icon: 'check' | 'deny' | 'shield' }> = {
  once: { tone: 'ok', key: 'approvalAllowedOnce', icon: 'check' },
  session: { tone: 'ok', key: 'approvalAllowedSession', icon: 'check' },
  remember: { tone: 'ok', key: 'approvalAllowedRemember', icon: 'check' },
  deny: { tone: 'muted', key: 'approvalDenied', icon: 'deny' }
}

function statusOf(approval: ApprovalReceiptRecord): (typeof RECEIPT_STATUS)[ApprovalChoice] {
  const base = RECEIPT_STATUS[approval.choice]
  if (approval.reviewer !== 'model') return base
  return { ...base, key: approval.choice === 'deny' ? 'approvalReviewDenied' : 'approvalReviewAllowed' }
}

export function TurnApprovalLine({ approvals }: { approvals: readonly ApprovalReceiptRecord[] }): JSX.Element | null {
  const tt = useSessionText()
  const { lang } = useI18n()
  const last = approvals.at(-1)
  if (!last) return null
  const denied = approvals.filter((approval) => approval.choice === 'deny').length
  const single = approvals.length === 1
  const mixed = !single && denied > 0 && denied < approvals.length
  const status = mixed ? { ...RECEIPT_STATUS.once, tone: 'muted' as const, icon: 'shield' as const } : single ? statusOf(last) : RECEIPT_STATUS[denied === approvals.length ? 'deny' : 'once']
  const label = single ? tt(status.key) : tt('approvalSummary', { n: approvals.length, ok: approvals.length - denied, no: denied })
  const detail = approvals.map((approval) => `${tt(statusOf(approval).key)} · ${localizeApprovalText(approval.title, lang)}${approval.feedback ? ` \u2014 ${approval.feedback}` : ''}`).join('\n')
  return (
    <div className="v3-approval-line" data-choice={single ? last.choice : undefined} data-reviewer={single ? last.reviewer : undefined} data-testid="v3-turn-approval-line" title={detail}>
      <CardStatus tone={status.tone} icon={<Icon name={status.icon} size={13} />}>{label}</CardStatus>
      {single && last.title ? <span className="v3-approval-line-title">{localizeApprovalText(last.title, lang)}</span> : null}
      {single && last.feedback ? <span className="v3-approval-line-reason">{tt('approvalDeniedReason', { reason: last.feedback })}</span> : null}
      <CardTime at={last.at} className="v3-approval-line-time" />
    </div>
  )
}

export function ApprovalReceipt({ approval }: { approval: ApprovalReceiptRecord }): JSX.Element {
  const tt = useSessionText()
  const { lang } = useI18n()
  const status = statusOf(approval)
  const [fresh] = useState(() => claimFreshArrival('approval', approval.at))
  return (
    <Card receipt padding="none" className="v3-approval-receipt" data-fresh={fresh ? '' : undefined} data-choice={approval.choice} data-reviewer={approval.reviewer} data-testid="v3-approval-receipt">
      <CardHead className="v3-approval-receipt-head">
        <CardStatus tone={status.tone} icon={<Icon name={status.icon} size={14} />}>{tt(status.key)}</CardStatus>
        {approval.title ? <CardTitle className="v3-approval-receipt-title">{localizeApprovalText(approval.title, lang)}</CardTitle> : null}
        <CardMeta><CardTime at={approval.at} /></CardMeta>
      </CardHead>
      {approval.feedback ? <div className="v3-approval-receipt-reason">{tt('approvalDeniedReason', { reason: approval.feedback })}</div> : null}
    </Card>
  )
}
