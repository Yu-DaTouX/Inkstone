import { Gauge, Hourglass } from 'lucide-react'
import { useT } from '../i18n'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay } from '../ui'
import './ultracode.css'

export function UltracodeConfirmDialog({
  isOpen,
  onCancel,
  onConfirm
}: {
  isOpen: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <ModalOverlay isOpen={isOpen} isDismissable onOpenChange={(open) => { if (!open) onCancel() }}>
      <Modal data-dialog-size="md">
        <Dialog title={t('picker.deepConfirmTitle')} closeLabel={t('ui.cancel')} data-testid="ultracode-confirm">
          <p className="uc-lead">{t('picker.deepConfirmLead')}</p>
          <ul className="uc-costs">
            <li className="uc-cost">
              <Gauge size={16} aria-hidden />
              <span>
                <strong>{t('picker.deepCostQuota')}</strong>
                <span>{t('picker.deepCostQuotaDesc')}</span>
              </span>
            </li>
            <li className="uc-cost">
              <Hourglass size={16} aria-hidden />
              <span>
                <strong>{t('picker.deepCostTime')}</strong>
                <span>{t('picker.deepCostTimeDesc')}</span>
              </span>
            </li>
          </ul>
          <p className="uc-note">
            {t('picker.deepConfirmNote')}
            {t('picker.deepKeywordBefore')}
            <code className="uc-kw">/ultracode</code>
            {t('picker.deepKeywordAfter')}
          </p>
          <DialogFooter>
            <Button variant="ghost" autoFocus onPress={onCancel} data-testid="ultracode-cancel">{t('ui.cancel')}</Button>
            <Button variant="primary" onPress={onConfirm} data-testid="ultracode-confirm-on">
              {t('picker.deepConfirmOn')}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
