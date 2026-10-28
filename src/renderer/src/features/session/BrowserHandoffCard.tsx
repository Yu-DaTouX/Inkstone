import { useEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button, Notice } from '../../ui'
import { Card, CardActions, CardBody, CardHead, CardStatus, CardTitle } from '../../ui/Card'
import { sendAsComposerMessage } from '../../lib/composer-store-send'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { useStore } from '../../state/store'
import './wrap-up.css'

export function BrowserHandoffCard({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const browser = useStore((s) => (sessionId ? s.browserStates?.[sessionId] : undefined) ?? s.browserState)
  const openBrowser = useStore((s) => s.openBrowser)
  const request = browser.userControl ? browser.userControlRequest : undefined
  const mine = !!request && (!request.sessionId || request.sessionId === sessionId)
  const revealed = useRef<number | null>(null)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const embedded = browser.mode !== 'external' && !!browser.url

  useEffect(() => {
    if (!mine || !request || revealed.current === request.at) return
    revealed.current = request.at
    if (embedded) void openBrowser(browser.url)
  }, [mine, request, embedded, browser.url, openBrowser])

  if (!mine || !request) return null
  const done = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await window.yan.browser.releaseUserControl(sessionId ?? undefined)
      const view = useStore.getState()
      if (currentSession.current !== sessionId || (view.peekedSessionId ?? view.session?.sessionId) !== sessionId) return
      await sendAsComposerMessage(tt('browserHandoffMessage'), t)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return (
    <Card as="section" padding="md" className="v3-wrapup" data-pending="" aria-label={tt('browserHandoffTitle')} data-testid="v3-browser-handoff">
      <CardHead>
        <CardStatus tone="accent" icon={<Icon name="help" size={14} />}>{tt('awaitAction')}</CardStatus>
        <CardTitle>{tt('browserHandoffTitle')}</CardTitle>
      </CardHead>
      <CardBody className="v3-wrapup-body">
        <p className="v3-wrapup-recap" data-testid="v3-browser-handoff-reason">{request.reason || tt('browserHandoffReason')}</p>
        <p className="v3-wrapup-recap">{tt('browserHandoffHint')}</p>
        {error ? <Notice tone="fail" compact>{error}</Notice> : null}
      </CardBody>
      <CardActions className="v3-wrapup-actions">
        {embedded ? (
          <Button variant="secondary" onPress={() => void openBrowser(browser.url)} data-testid="v3-browser-handoff-show">
            {tt('browserHandoffShow')}
          </Button>
        ) : null}
        <Button variant="primary" isPending={pending} onPress={() => void done()} data-testid="v3-browser-handoff-done">
          {tt('browserHandoffDone')}
        </Button>
      </CardActions>
    </Card>
  )
}
