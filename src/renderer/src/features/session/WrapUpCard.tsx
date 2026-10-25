import { useMemo, useSyncExternalStore, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button, Card, IconButton } from '../../ui'
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
  return (
    <Card as="section" padding="sm" className="v3-wrapup" data-pending={card.ask ? '' : undefined} aria-label={tt('wrapUpLabel')} data-testid="v3-wrap-up">
      <div className="v3-wrapup-head">
        <span className="v3-wrapup-kicker">
          <Icon name={card.ask ? 'help' : 'check'} size={13} />
          {card.ask ? tt('wrapUpDecide') : tt('wrapUpDone')}
        </span>
        <IconButton size="sm" aria-label={tt('wrapUpDismiss')} onPress={() => dismissWrapUp(dismissKey)} data-testid="v3-wrap-up-dismiss">
          <Icon name="close" size={14} />
        </IconButton>
      </div>
      <p className="v3-wrapup-recap" data-testid="v3-wrap-up-recap"><WrapUpText text={card.recap} /></p>
      {card.ask ? (
        <div className="v3-wrapup-ask">
          <p className="v3-wrapup-question" data-testid="v3-wrap-up-question"><WrapUpText text={card.ask} /></p>
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
