import { useState } from 'react'
import { Dialog, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover } from 'react-aria-components'
import { Check, Shield } from 'lucide-react'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PERMISSION_MODES, normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'

/**
 * 输入框底部一行的权限入口（WP-24，方案 §8.7）。
 *
 * 两档全局设置直接落 `settings.permissionMode`，不恢复旧工作模式。
 * 「自动批准」（danger）是缺省；切到「不受限制」（all）会让砚不再审批也不拦截，
 * 所以必须先弹一次确认，确认后才写设置。
 */
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
          size="sm"
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
                <span className="cpm-hint">{t(`permission.desc.${mode}` as 'permission.desc.danger')}</span>
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>

      <ModalOverlay className="composer-perm-overlay" isOpen={confirmAll} onOpenChange={setConfirmAll}>
        <Modal className="composer-perm-modal">
          <Dialog className="composer-perm-dialog" aria-label={t('permission.label.all')}>
            <p className="composer-perm-title">{t('permission.label.all')}</p>
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
