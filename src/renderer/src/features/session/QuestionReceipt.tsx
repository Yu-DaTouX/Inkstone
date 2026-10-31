import type { JSX } from 'react'
import type { UIToolCall } from '../../../../shared/ipc'
import { Collapsible, CollapsibleHeader, CollapsiblePanel } from '../../ui'
import { CardTime } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText, type SessionTextKey } from './text'
import { questionHistory, type QuestionHistoryModel } from './question-receipt'
import { useToolExpansion } from './use-tool-run'
import './question.css'

const STATE_TEXT: Record<QuestionHistoryModel['state'], SessionTextKey> = {
  pending: 'questionPending',
  answered: 'questionAnswered',
  skipped: 'questionSkipped',
  failed: 'questionFailed'
}

function answerPreview(model: QuestionHistoryModel): string {
  const items = model.items.map((item) => [
    ...item.options.filter((option) => option.chosen).map((option) => option.label),
    ...(item.answer ? [item.answer] : [])
  ].join('、')).filter(Boolean)
  const pairs = model.pairs.map((pair) => pair.value)
  return [...items, ...pairs].join(' · ').replace(/\s+/g, ' ')
}

function QuestionRow({ call, testId }: { call: UIToolCall; testId: string }): JSX.Element {
  const tt = useSessionText()
  const model = questionHistory(call)
  const [stored, setOpen] = useToolExpansion(`question:${call.id}`)
  const open = stored ?? false
  const first = model.items[0]?.question || tt('questionLabel')
  const more = model.items.length - 1
  const answered = model.state === 'answered'
  const preview = answered ? answerPreview(model) : tt(STATE_TEXT[model.state])
  const at = model.state === 'pending' ? undefined : call.endedAt ?? call.startedAt
  return (
    <Collapsible className="v3-step v3-qrow" data-state={model.state} data-open={open || undefined} data-testid={testId} isExpanded={open} onExpandedChange={setOpen}>
      <CollapsibleHeader
        className="v3-step-head"
        size="compact"
        chevron="end"
        icon={<Icon name={model.state === 'failed' ? 'warn' : 'message'} size={13} />}
        accessory={at ? <CardTime at={at} className="v3-qrow-time" /> : undefined}
      >
        <span className="v3-step-line v3-qrow-line" title={first}>
          <span className="v3-qrow-q">{open ? first : first.replace(/\s+/g, ' ')}</span>
          {more > 0 ? <span className="v3-qrow-more">{tt('questionMore', { n: more })}</span> : null}
          {preview ? <span className="v3-qrow-a" data-answered={answered || undefined}>{preview}</span> : null}
        </span>
      </CollapsibleHeader>
      <CollapsiblePanel animated className="v3-step-panel">
        {open ? (
          <div className="v3-qrow-detail" data-testid={`${testId}-detail`}>
            {model.items.map((item, index) => (
              <section key={index} className="v3-qrow-item" aria-label={item.question || tt('questionLabel')}>
                {item.header ? <div className="v3-qrow-header">{item.header}</div> : null}
                {index > 0 ? <p className="v3-qrow-question">{item.question || tt('questionLabel')}</p> : null}
                {item.options.length ? (
                  <ul className="v3-qrow-options">
                    {item.options.map((option) => (
                      <li key={option.label} className="v3-qrow-option" data-chosen={option.chosen || undefined} title={option.description || undefined}>
                        <span className="v3-qrow-mark" aria-hidden>{option.chosen ? <Icon name="check" size={12} /> : null}</span>
                        <span className="v3-qrow-label">{option.label}</span>
                        {option.chosen ? <span className="sr-only">{tt('questionChosen')}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.answer ? <p className="v3-qrow-answer">{item.options.length ? tt('questionFreeAnswer', { answer: item.answer }) : item.answer}</p> : null}
              </section>
            ))}
            {model.pairs.length ? (
              <dl className="v3-qrow-pairs">
                {model.pairs.map((pair, i) => (
                  <div key={i} className="v3-qrow-pair">
                    <dt>{pair.label}</dt>
                    <dd>{pair.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  )
}

export function QuestionReceipt({ call }: { call: UIToolCall }): JSX.Element {
  return <QuestionRow call={call} testId="v3-question-receipt" />
}

export function QuestionHistory({ call }: { call: UIToolCall }): JSX.Element {
  return <QuestionRow call={call} testId="v3-question-history" />
}
