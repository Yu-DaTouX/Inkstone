import type { JSX } from 'react'
import { useStore } from '../../state/store'
import { viewMatchesProjectedSession, sessionViewIdentity } from './view-state'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
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

  const model = errorCardModel(error)
  if (!model) return null

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const active = viewMatchesProjectedSession(view, session)
  const prompt = promptForTurn(sourceIds, messages)

  const actions = active ? model.actions.filter((action) => action !== 'retry' || !!prompt) : []

  const run = (action: ErrorCardAction): void => {
    if (action === 'retry') {
      if (prompt) void send(prompt.text, prompt.images.length ? prompt.images : undefined)
      return
    }
    if (action === 'model') {
      void cycleModel()
      return
    }
    void compact()
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
      </div>
      <p className="v3-errorcard-body" data-testid="v3-error-body">{model.body}</p>
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
