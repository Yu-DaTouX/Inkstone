import type { JSX } from 'react'
import { useI18n } from '../../i18n'
import type { ApprovalRequest } from '../../../../shared/approval'
import { Spinner } from '../../ui'
import { Card, CardBody, CardCode, CardHead, CardStatus, CardTitle } from '../../ui/Card'
import { localizeApprovalText } from './approval-reason-text'
import { revealHiddenChars } from './approval-keys'
import { useSessionText } from './text'
import './approval.css'

export function ApprovalReviewCard({ request }: { request: ApprovalRequest }): JSX.Element {
  const tt = useSessionText()
  const { lang } = useI18n()
  const reasons = request.reasons.map((reason) => localizeApprovalText(reason, lang))
  const headline = reasons[0] ?? localizeApprovalText(request.title, lang)
  return (
    <Card
      padding="md"
      className="v3-approval v3-approval-reviewing"
      role="status"
      aria-live="polite"
      aria-label={`${tt('approvalReviewing')} ${headline}`}
      data-testid="v3-approval-review"
      data-kind={request.kind}
    >
      <CardHead className="v3-approval-head">
        <CardStatus tone="run" icon={<Spinner size="xs" />}>{tt('approvalReviewing')}</CardStatus>
        <CardTitle className="v3-approval-title">{headline}</CardTitle>
      </CardHead>
      <CardBody className="v3-approval-body">
        <p className="v3-approval-read-hint" data-testid="v3-approval-review-hint">{tt('approvalReviewingHint')}</p>
        {reasons.length > 1 ? (
          <ul className="v3-approval-reasons" data-testid="v3-approval-reasons">
            {reasons.slice(1).map((reason, i) => <li key={i}>{reason}</li>)}
          </ul>
        ) : null}
        {request.detail ? <CardCode className="v3-approval-detail" data-testid="v3-approval-detail">{revealHiddenChars(request.detail)}</CardCode> : null}
      </CardBody>
    </Card>
  )
}
