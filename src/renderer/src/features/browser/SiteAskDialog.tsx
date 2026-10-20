import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, Modal, ModalOverlay } from '../../ui'
import { browserText } from './browser-text'
import './browser.css'

interface SiteAsk {
  id: string
  origin: string
  url: string
}

export function BrowserSiteAskDialog(): ReactElement | null {
  const { lang } = useI18n()
  const text = browserText(lang)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [ask, setAsk] = useState<SiteAsk | null>(null)

  useEffect(
    () =>
      window.yan.onPush((msg) => {
        if (msg.ch === 'browser-site-ask') setAsk(msg.payload)
      }),
    []
  )

  useEffect(() => {
    if (!ask) return undefined
    return acquireOverlayBlocker('browser-site-ask')
  }, [ask, acquireOverlayBlocker])

  if (!ask) return null

  const decide = (allowed: boolean): void => {
    void window.yan.browser.siteAskAnswer(ask.id, allowed).catch(() => undefined)
    setAsk(null)
  }

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) decide(false) }}>
      <Modal className="v3-browser-site-ask">
        <Dialog title={text.siteAskTitle} closeLabel={text.siteAskDeny} data-testid="browser-site-ask">
          <p className="v3-browser-site-ask__lead" data-testid="browser-site-ask-origin">{text.siteAskLead(ask.origin)}</p>
          <p className="v3-browser-site-ask__url" title={ask.url}>{ask.url}</p>
          <p className="v3-browser-site-ask__detail">{text.siteAskDetail}</p>
          <div className="v3-browser-site-ask__actions">
            <Button data-testid="browser-site-ask-deny" onPress={() => decide(false)}>
              {text.siteAskDeny}
            </Button>
            <Button variant="primary" data-testid="browser-site-ask-allow" onPress={() => decide(true)}>
              {text.siteAskAllow}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
