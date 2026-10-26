import type { JSX } from 'react'
import type { ApprovalChoice, ApprovalReceipt as ApprovalReceiptRecord } from '../../../../shared/approval'
import { Card, CardHead, CardMeta, CardStatus, CardTime, CardTitle, type CardStatusTone } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText, type SessionTextKey } from './text'
import './approval.css'

const RECEIPT_STATUS: Record<ApprovalChoice, { tone: CardStatusTone; key: SessionTextKey; icon: 'check' | 'deny' }> = {
  once: { tone: 'ok', key: 'approvalAllowedOnce', icon: 'check' },
  session: { tone: 'ok', key: 'approvalAllowedSession', icon: 'check' },
  remember: { tone: 'ok', key: 'approvalAllowedRemember', icon: 'check' },
  deny: { tone: 'muted', key: 'approvalDenied', icon: 'deny' }
}

export function ApprovalReceipt({ approval }: { approval: ApprovalReceiptRecord }): JSX.Element {
  const tt = useSessionText()
  const status = RECEIPT_STATUS[approval.choice]
  return (
    <Card receipt padding="none" className="v3-approval-receipt" data-choice={approval.choice} data-testid="v3-approval-receipt">
      <CardHead className="v3-approval-receipt-head">
        <CardStatus tone={status.tone} icon={<Icon name={status.icon} size={14} />}>{tt(status.key)}</CardStatus>
        {approval.title ? <CardTitle className="v3-approval-receipt-title">{approval.title}</CardTitle> : null}
        <CardMeta><CardTime at={approval.at} /></CardMeta>
      </CardHead>
      {approval.feedback ? <div className="v3-approval-receipt-reason">{tt('approvalDeniedReason', { reason: approval.feedback })}</div> : null}
    </Card>
  )
}
