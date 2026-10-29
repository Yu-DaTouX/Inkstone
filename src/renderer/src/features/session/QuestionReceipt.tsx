import type { ComponentProps, JSX } from 'react'
import type { UIToolCall } from '../../../../shared/ipc'
import { Card, CardHead, CardMeta, CardStatus, CardTime, CardTitle, type CardStatusTone } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText, type SessionTextKey } from './text'
import { questionHistory, questionReceipt } from './question-receipt'
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

export function QuestionHistory({ call }: { call: UIToolCall }): JSX.Element {
  const tt = useSessionText()
  const model = questionHistory(call)
  const status = RECEIPT_STATUS[model.state]
  const at = model.state === 'pending' ? undefined : call.endedAt ?? call.startedAt
  return (
    <Card padding="none" className="v3-qhistory" data-state={model.state} data-testid="v3-question-history">
      {model.items.map((item, index) => (
        <section key={index} className="v3-qhistory-item" aria-label={item.question || tt('questionLabel')}>
          <CardHead className="v3-qreceipt-head">
            {index === 0 ? <CardStatus tone={status.tone} icon={status.icon ? <Icon name={status.icon} size={14} /> : undefined}>{tt(status.key)}</CardStatus> : null}
            <CardTitle className="v3-qreceipt-title">{item.question || tt('questionLabel')}</CardTitle>
            {index === 0 && at ? <CardMeta><CardTime at={at} /></CardMeta> : null}
          </CardHead>
          {item.options.length ? (
            <ul className="v3-qhistory-options">
              {item.options.map((option) => (
                <li key={option.label} className="v3-qhistory-option" data-chosen={option.chosen || undefined} title={option.description || undefined}>
                  <span className="v3-qhistory-mark" aria-hidden>{option.chosen ? <Icon name="check" size={12} /> : null}</span>
                  <span className="v3-qhistory-label">{option.label}</span>
                  {option.chosen ? <span className="sr-only">{tt('questionChosen')}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {item.answer ? <div className="v3-qhistory-answer">{item.options.length ? tt('questionFreeAnswer', { answer: item.answer }) : item.answer}</div> : null}
        </section>
      ))}
      {model.pairs.length ? (
        <div className="v3-qreceipt-pairs">
          {model.pairs.map((pair, i) => (
            <div key={i} className="v3-qreceipt-pair">
              <div className="v3-qreceipt-q">{pair.label}</div>
              <div className="v3-qreceipt-a">{pair.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}
