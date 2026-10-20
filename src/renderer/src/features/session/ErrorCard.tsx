import { useState, type JSX } from 'react'
import { useStore } from '../../state/store'
import { viewMatchesProjectedSession, sessionViewIdentity } from './view-state'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { forgetToolExpansion } from './tool-expansion'
import { errorCardModel, errorTitleKey, promptForTurn, type ErrorCardAction } from './turn-lines'

export function ErrorCard({ sourceIds, error }: { sourceIds: readonly string[]; error: string }): JSX.Element | null {
  const tt = useSessionText()
  const send = useStore((s) => s.send)
  const cycleModel = useStore((s) => s.cycleModel)
  const compact = useStore((s) => s.compact)
  const messages = useStore((s) => s.messages)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const model = errorCardModel(error)
  if (!model) return null

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const active = viewMatchesProjectedSession(view, session)
  const prompt = promptForTurn(sourceIds, messages)

  const actions = active ? model.actions.filter((action) => action !== 'retry' || !!prompt) : []

  const run = (action: ErrorCardAction): void => {
    if (action === 'retry') {
      if (!prompt) return
      forgetToolExpansion(view.key)
      void send(prompt.text, prompt.images.length ? prompt.images : undefined)
      return
    }
    if (action === 'model') {
      void cycleModel()
      return
    }
    void compact()
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(model.body).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      },
      () => undefined
    )
  }

  const LABEL: Record<ErrorCardAction, string> = {
    retry: tt('errorRetry'),
    model: tt('errorModel'),
    compact: tt('errorCompact')
  }

  return (
    <div className="v3-errorcard" role="alert" data-testid="v3-error-card" data-kind={model.kind}>
      <div className="v3-errorcard-head">
        <Icon name="warn" size={14} />
        <span className="v3-errorcard-title" data-testid="v3-error-title">{tt(errorTitleKey(model))}</span>
        <span className="v3-code-sp" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={detailsOpen}
          data-testid="v3-error-toggle"
          trailingIcon={<Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={14} />}
          onPress={() => setDetailsOpen((open) => !open)}
        >
          {tt('errViewDetails')}
        </Button>
      </div>
      {detailsOpen ? (
        <div className="v3-errorcard-details" data-testid="v3-error-body">
          <p className="v3-errorcard-body">{model.body}</p>
          <div className="v3-errorcard-detail-foot">
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name={copied ? 'check' : 'copy'} size={14} />}
              data-testid="v3-error-copy"
              onPress={copy}
            >
              {copied ? tt('msgCopied') : tt('errCopyDetails')}
            </Button>
            <span className="v3-errorcard-status" role="status" aria-live="polite">
              {copied ? tt('msgCopied') : ''}
            </span>
          </div>
        </div>
      ) : null}
      {actions.length ? (
        <div className="v3-errorcard-actions">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === 'retry' ? 'primary' : 'ghost'}
              data-testid={`v3-error-${action}`}
              onPress={() => run(action)}
            >
              {LABEL[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
