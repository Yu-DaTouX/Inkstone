import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, MiddleTruncate, Modal, ModalOverlay } from '../../ui'
import { answerStopConfirm, stopConfirmSummary, subscribeStopConfirm } from './stop-with-background'

export function StopBackgroundDialog(): ReactElement | null {
  const t = useT()
  const summary = useSyncExternalStore(subscribeStopConfirm, stopConfirmSummary)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)

  useEffect(() => {
    if (!summary) return undefined
    return acquireOverlayBlocker('stop-background-confirm')
  }, [summary, acquireOverlayBlocker])

  if (!summary) return null

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) answerStopConfirm('cancel') }}>
      <Modal>
        <Dialog title={t('stopBg.title')} data-testid="stop-background-confirm">
          <p className="ui-confirm__desc">{t('stopBg.desc', { count: summary.count })}</p>
          <div data-testid="stop-background-list">
            {summary.commands.map((command, index) => (
              <p key={index} className="ui-confirm__desc">
                <MiddleTruncate value={command} />
              </p>
            ))}
            {summary.more > 0 ? <p className="ui-confirm__desc">{t('stopBg.more', { count: summary.more })}</p> : null}
          </div>
          <DialogFooter>
            <Button autoFocus data-testid="stop-background-turn-only" onPress={() => answerStopConfirm('turn')}>
              {t('stopBg.turnOnly')}
            </Button>
            <Button variant="danger" data-testid="stop-background-together" onPress={() => answerStopConfirm('together')}>
              {t('stopBg.together')}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
