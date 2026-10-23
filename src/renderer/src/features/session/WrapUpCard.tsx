import { useSyncExternalStore, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button, Card, IconButton } from '../../ui'
import { sendAsComposerMessage } from '../../lib/composer-store-send'
import { Icon } from './Icon'
import { useSessionText } from './text'
import type { WrapUpCardModel } from './wrap-up'
import './wrap-up.css'

const dismissed = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function wrapUpKey(sessionId: string | null, callId: string): string {
  return `${sessionId ?? ''}\u0000${callId}`
}

export function dismissWrapUp(key: string): void {
  if (dismissed.has(key)) return
  dismissed.add(key)
  for (const listener of [...listeners]) listener()
}

export function useWrapUpDismissed(key: string): boolean {
  return useSyncExternalStore(subscribe, () => dismissed.has(key))
}

export function WrapUpCard({ card, dismissKey }: { card: WrapUpCardModel; dismissKey: string }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const hidden = useWrapUpDismissed(dismissKey)
  if (hidden) return null
  const choose = (message: string): void => {
    dismissWrapUp(dismissKey)
    void sendAsComposerMessage(message, t)
  }
  return (
    <Card as="section" padding="sm" className="v3-wrapup" aria-label={tt('wrapUpLabel')} data-testid="v3-wrap-up">
      <div className="v3-wrapup-head">
        <p className="v3-wrapup-recap" data-testid="v3-wrap-up-recap">{card.recap}</p>
        <IconButton size="sm" aria-label={tt('wrapUpDismiss')} onPress={() => dismissWrapUp(dismissKey)} data-testid="v3-wrap-up-dismiss">
          <Icon name="close" size={14} />
        </IconButton>
      </div>
      {card.ask ? (
        <div className="v3-wrapup-ask">
          <p className="v3-wrapup-question"><strong>{card.ask}</strong></p>
          {card.actions.length ? (
            <div className="v3-wrapup-actions">
              {card.actions.map((action, index) => (
                <Button
                  key={`${index}:${action.label}`}
                  size="sm"
                  variant={index === 0 ? 'primary' : 'secondary'}
                  title={action.message}
                  onPress={() => choose(action.message)}
                  data-testid="v3-wrap-up-action"
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
