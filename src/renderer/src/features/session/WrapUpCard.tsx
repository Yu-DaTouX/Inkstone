import { useMemo, useSyncExternalStore, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../../ui'
import { Card, CardActions, CardBody, CardControl, CardHead, CardStatus, CardTitle } from '../../ui/Card'
import { sendAsComposerMessage } from '../../lib/composer-store-send'
import { composerLocalCommand } from '../composer/composer-layout'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { parseUserInline } from './user-text'
import { isFillInTemplate, type WrapUpCardModel } from './wrap-up'
import { useStore } from '../../state/store'
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
  const isDismissed = (): boolean => dismissed.has(key)
  return useSyncExternalStore(subscribe, isDismissed, isDismissed)
}

function WrapUpText({ text }: { text: string }): JSX.Element {
  const runs = useMemo(() => parseUserInline(text), [text])
  return <>{runs.map((run, index) => run.kind === 'code' ? <code key={index} className="v3-wrapup-code">{run.text}</code> : run.text)}</>
}

export function WrapUpCard({ card, dismissKey }: { card: WrapUpCardModel; dismissKey: string }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const hidden = useWrapUpDismissed(dismissKey)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  if (hidden || !card.ask?.trim()) return null
  const choose = (message: string): void => {
    dismissWrapUp(dismissKey)
    if (isFillInTemplate(message) || composerLocalCommand(message.trim(), useStore.getState().commands)) insertIntoComposer(message)
    else void sendAsComposerMessage(message, t)
  }
  const ordered = card.actions.map((action, index) => ({ action, index }))
  const actions = [...ordered.slice(1), ...ordered.slice(0, 1)]
  return (
    <Card as="section" padding="md" className="v3-wrapup" data-pending="" aria-label={tt('wrapUpLabel')} data-testid="v3-wrap-up">
      <CardHead>
        <CardStatus tone="accent" icon={<Icon name="help" size={14} />}>{tt('wrapUpDecide')}</CardStatus>
        <CardTitle className="v3-wrapup-question" data-testid="v3-wrap-up-question"><WrapUpText text={card.ask} /></CardTitle>
        <CardControl>
          <IconButton size="sm" aria-label={tt('wrapUpDismiss')} onPress={() => dismissWrapUp(dismissKey)} data-testid="v3-wrap-up-dismiss">
            <Icon name="close" size={14} />
          </IconButton>
        </CardControl>
      </CardHead>
      {card.recap.trim() ? (
        <CardBody>
          <p className="v3-wrapup-recap" data-testid="v3-wrap-up-recap"><WrapUpText text={card.recap} /></p>
        </CardBody>
      ) : null}
      {actions.length ? (
        <CardActions className="v3-wrapup-actions">
          {actions.map(({ action, index }) => (
            <Button
              key={`${index}:${action.label}`}
              variant={index === 0 ? 'primary' : 'secondary'}
              title={action.message}
              onPress={() => choose(action.message)}
              data-testid="v3-wrap-up-action"
            >
              {action.label}
            </Button>
          ))}
        </CardActions>
      ) : null}
    </Card>
  )
}
