import { useState } from 'react'
import { Menu, MenuItem, MenuTrigger } from 'react-aria-components'
import { Check, Shield } from 'lucide-react'
import { Button, Dialog, Modal, ModalOverlay, Popover } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PERMISSION_MODES, normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'

export function PermissionToggle() {
  const t = useT()
  const permission = normalizePermissionMode(useStore((s) => s.settings?.permissionMode))
  const patchSettings = useStore((s) => s.patchSettings)
  const notify = useStore((s) => s.notify)
  const [confirmAll, setConfirmAll] = useState(false)

  const apply = (mode: PermissionMode): void => {
    void patchSettings({ permissionMode: mode }).catch((error) => notify('error', String(error)))
  }

  return (
    <>
      <MenuTrigger>
        <Button
          variant="ghost"
          className="composer-permission"
          data-mode={permission}
          aria-haspopup="menu"
          data-testid="permission-picker"
        >
          <Shield size={13} aria-hidden />
          <span className="cp-label">{t(`permission.label.${permission}` as 'permission.label.danger')}</span>
        </Button>
        <Popover className="composer-permission-pop" placement="top start" offset={6}>
          <Menu className="composer-permission-menu" aria-label={t('permission.title')}>
            {PERMISSION_MODES.map((mode) => (
              <MenuItem
                key={mode}
                className="cpm-item"
                textValue={t(`permission.label.${mode}` as 'permission.label.danger')}
                data-current={mode === permission ? 'true' : undefined}
                onAction={() => {
                  if (mode === permission) return
                  if (mode === 'all') setConfirmAll(true)
                  else apply(mode)
                }}
              >
                <span className="cpm-label">{t(`permission.label.${mode}` as 'permission.label.danger')}</span>
                {mode === permission ? <Check className="cpm-check" size={13} aria-hidden /> : null}
                <span className="cpm-hint">{t(`permission.hint.${mode}` as 'permission.hint.danger')}</span>
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>

      <ModalOverlay isOpen={confirmAll} onOpenChange={setConfirmAll} isDismissable>
        <Modal className="composer-perm-modal">
          <Dialog className="composer-perm-dialog" title={t('permission.label.all')} showClose={false}>
            <p className="composer-perm-body">{t('permission.desc.all')}</p>
            <div className="composer-perm-actions">
              <Button variant="secondary" size="sm" onPress={() => setConfirmAll(false)}>
                {t('ui.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="permission-confirm-all"
                onPress={() => {
                  setConfirmAll(false)
                  apply('all')
                }}
              >
                {t('ui.confirm')}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  )
}
