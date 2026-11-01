import { ArrowRight, ArrowRightLeft } from 'lucide-react'
import './ModelChangeNotice.css'

export function ModelChangeNotice(props: { label: string; previous: string; next: string }) {
  return (
    <div className="ui-model-change-notice" role="status" data-testid="pending-model-change">
      <span className="ui-model-change-notice__rule" aria-hidden="true" />
      <ArrowRightLeft aria-hidden="true" />
      <span>{props.label}</span>
      <span className="ui-model-change-notice__previous" title={props.previous}>{props.previous}</span>
      <ArrowRight aria-hidden="true" />
      <span className="ui-model-change-notice__next" title={props.next}>{props.next}</span>
      <span className="ui-model-change-notice__rule" aria-hidden="true" />
    </div>
  )
}
