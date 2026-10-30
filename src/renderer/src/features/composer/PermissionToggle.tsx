import { useState } from 'react'
import { ChevronDown, Shield } from 'lucide-react'
import { Button, ConfirmDialog, Menu, MenuItem, MenuTrigger, Popover } from '../../ui'
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

  const label = t(`permission.label.${permission}` as 'permission.label.danger')

  return (
    <>
      <MenuTrigger>
        <Button
          variant="ghost"
          className="composer-permission"
          data-mode={permission}
          aria-haspopup="menu"
          aria-label={`${t('permission.title')}: ${label}`}
          title={label}
          data-testid="permission-picker"
          icon={<Shield size={14} />}
          trailingIcon={<ChevronDown className="cp-chev" size={12} />}
        >
          <span className="cp-label">{label}</span>
        </Button>
        <Popover className="composer-permission-pop" placement="top start" offset={6}>
          <Menu className="composer-permission-menu" aria-label={t('permission.title')}>
            {PERMISSION_MODES.map((mode) => (
              <MenuItem
                key={mode}
                textValue={t(`permission.label.${mode}` as 'permission.label.danger')}
                checked={mode === permission}
                description={t(`permission.hint.${mode}` as 'permission.hint.danger')}
                data-current={mode === permission ? 'true' : undefined}
                onAction={() => {
                  if (mode === permission) return
                  if (mode === 'all') setConfirmAll(true)
                  else apply(mode)
                }}
              >
                {t(`permission.label.${mode}` as 'permission.label.danger')}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>

      <ConfirmDialog
        isOpen={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('permission.label.all')}
        description={t('permission.desc.all')}
        tone="danger"
        cancelLabel={t('ui.cancel')}
        confirmLabel={t('ui.confirm')}
        confirmTestId="permission-confirm-all"
        onConfirm={() => apply('all')}
      />
    </>
  )
}
