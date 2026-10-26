import type { ComponentProps, JSX } from 'react'
import type { UIToolCall } from '../../../../shared/ipc'
import { Card, CardHead, CardMeta, CardStatus, CardTime, CardTitle, type CardStatusTone } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText, type SessionTextKey } from './text'
import { questionReceipt } from './question-receipt'
import './question.css'

const RECEIPT_STATUS: Record<ReturnType<typeof questionReceipt>['state'], { tone: CardStatusTone; key: SessionTextKey; icon: ComponentProps<typeof Icon>['name'] | null }> = {
  pending: { tone: 'accent', key: 'questionPending', icon: 'message' },
  answered: { tone: 'ok', key: 'questionAnswered', icon: 'check' },
  skipped: { tone: 'muted', key: 'questionSkipped', icon: null },
  failed: { tone: 'fail', key: 'questionFailed', icon: 'warn' }
}

export function QuestionReceipt({ call }: { call: UIToolCall }): JSX.Element {
  const tt = useSessionText()
  const model = questionReceipt(call)
  const status = RECEIPT_STATUS[model.state]
  const at = model.state === 'pending' ? undefined : call.endedAt ?? call.startedAt
  const pairs = model.answer ? [{ label: '', value: model.answer }, ...model.pairs] : model.pairs
  return (
    <Card receipt padding="none" className="v3-qreceipt" data-state={model.state} data-testid="v3-question-receipt">
      <CardHead className="v3-qreceipt-head">
        <CardStatus tone={status.tone} icon={status.icon ? <Icon name={status.icon} size={14} /> : undefined}>{tt(status.key)}</CardStatus>
        <CardTitle className="v3-qreceipt-title">{model.question || tt('questionLabel')}</CardTitle>
        {at ? <CardMeta><CardTime at={at} /></CardMeta> : null}
      </CardHead>
      {pairs.length ? (
        <div className="v3-qreceipt-pairs">
          {pairs.map((pair, i) => (
            <div key={i} className="v3-qreceipt-pair">
              {pair.label ? <div className="v3-qreceipt-q">{pair.label}</div> : null}
              <div className="v3-qreceipt-a">{pair.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}
