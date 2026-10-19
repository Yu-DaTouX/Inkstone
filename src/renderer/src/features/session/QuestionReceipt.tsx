import type { JSX } from 'react'
import type { UIToolCall } from '../../../../shared/ipc'
import { ShimmerText } from '../../ui'
import { useSessionText } from './text'
import { questionReceipt } from './question-receipt'

export function QuestionReceipt({ call }: { call: UIToolCall }): JSX.Element {
  const tt = useSessionText()
  const model = questionReceipt(call)
  return (
    <div className="v3-qreceipt" data-state={model.state} data-testid="v3-question-receipt">
      <div className="v3-qreceipt-pair">
        <div className="v3-qreceipt-q">{model.question || tt('questionLabel')}</div>
        {model.state === 'pending' ? (
          <ShimmerText className="v3-qreceipt-a" active>{tt('questionPending')}</ShimmerText>
        ) : model.state === 'answered' && model.answer ? (
          <div className="v3-qreceipt-a">{model.answer}</div>
        ) : model.state !== 'answered' ? (
          <div className="v3-qreceipt-a dim">{model.state === 'failed' ? tt('questionFailed') : tt('questionSkipped')}</div>
        ) : null}
      </div>
      {model.pairs.map((pair, i) => (
        <div key={i} className="v3-qreceipt-pair">
          <div className="v3-qreceipt-q">{pair.label}</div>
          <div className="v3-qreceipt-a">{pair.value}</div>
        </div>
      ))}
    </div>
  )
}
