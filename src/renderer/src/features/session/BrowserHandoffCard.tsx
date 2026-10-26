import { useEffect, useRef, type JSX } from 'react'
import { useT } from '../../i18n'
import { Button } from '../../ui'
import { Card, CardActions, CardBody, CardHead, CardStatus, CardTitle } from '../../ui/Card'
import { sendAsComposerMessage } from '../../lib/composer-store-send'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { useStore } from '../../state/store'
import './wrap-up.css'

export function BrowserHandoffCard({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const browser = useStore((s) => s.browserState)
  const openBrowser = useStore((s) => s.openBrowser)
  const request = browser.userControl ? browser.userControlRequest : undefined
  const mine = !!request && (!request.sessionId || request.sessionId === sessionId)
  const revealed = useRef<number | null>(null)
  const embedded = browser.mode !== 'external' && !!browser.url

  useEffect(() => {
    if (!mine || !request || revealed.current === request.at) return
    revealed.current = request.at
    if (embedded) void openBrowser(browser.url)
  }, [mine, request, embedded, browser.url, openBrowser])

  if (!mine || !request) return null
  const done = async (): Promise<void> => {
    await window.yan.browser.releaseUserControl().catch(() => undefined)
    await sendAsComposerMessage(tt('browserHandoffMessage'), t)
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
      </CardBody>
      <CardActions className="v3-wrapup-actions">
        {embedded ? (
          <Button variant="secondary" onPress={() => void openBrowser(browser.url)} data-testid="v3-browser-handoff-show">
            {tt('browserHandoffShow')}
          </Button>
        ) : null}
        <Button variant="primary" onPress={() => void done()} data-testid="v3-browser-handoff-done">
          {tt('browserHandoffDone')}
        </Button>
      </CardActions>
    </Card>
  )
}
