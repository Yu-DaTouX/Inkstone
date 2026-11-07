import { useEffect, useState, type ReactElement } from 'react'
import type { AppUpdateWhatsNew } from '../../../../shared/app-update'
import { useT } from '../../i18n'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay } from '../../ui'
import { Markdown } from '../session/Markdown'
import './WhatsNewDialog.css'

export function WhatsNewDialog(): ReactElement | null {
  const t = useT()
  const [release, setRelease] = useState<AppUpdateWhatsNew | null>(null)
  useEffect(() => {
    let alive = true
    void window.yan.appUpdate.whatsNew().then((next) => { if (alive) setRelease(next) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  if (!release) return null
  const close = (): void => {
    setRelease(null)
    void window.yan.appUpdate.whatsNewSeen(release.version).catch(() => undefined)
  }
  return (
    <ModalOverlay isDismissable isOpen onOpenChange={(open) => { if (!open) close() }}>
      <Modal className="v3-whats-new">
        <Dialog title={t('update.whatsNewTitle', { v: release.version })} closeLabel={t('update.whatsNewDone')} data-testid="whats-new">
          <div className="v3-whats-new__body">
            <Markdown text={release.notes} />
          </div>
          <DialogFooter>
            <Button variant="primary" onPress={close} data-testid="whats-new-done">{t('update.whatsNewDone')}</Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
