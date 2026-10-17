import { useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { PERMISSION_MODES, normalizePermissionMode, type PermissionMode } from '../../../../../shared/approval'
import { useStore } from '../../../state/store'
import { Button, Dialog, Modal, ModalOverlay, Switch } from '../../../ui'
import { generalText } from './general-text'
import { permissionNeedsConfirm } from './general-model'
import { SettingsGroup, SettingsRow, Segmented } from '../root/controls'
import { PiProjectTrustGroup } from './PiNativeSettings'

export interface AllowRootsListProps {
  roots: readonly string[]
  emptyText: string
  removeText: string
  onRemove: (path: string) => void
}

export function AllowRootsList({ roots, emptyText, removeText, onRemove }: AllowRootsListProps): ReactElement {
  if (roots.length === 0) {
    return (
      <p className="settings-row__desc" data-testid="v3-security-roots-empty">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="settings-roots" data-testid="v3-security-roots">
      {roots.map((path) => (
        <li className="settings-root" key={path} data-testid="v3-security-root">
          <span className="settings-root__path" title={path}>
            {path}
          </span>
          <Button size="sm" variant="ghost" onPress={() => onRemove(path)}>
            {removeText}
          </Button>
        </li>
      ))}
    </ul>
  )
}

export function SecuritySettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const removeGuardAllowRoot = useStore((s) => s.removeGuardAllowRoot)
  const mode = normalizePermissionMode(settings?.permissionMode)
  const outside = settings?.guardOutsideWrites === true
  const roots = settings?.guardAllowRoots ?? []
  const [confirmAll, setConfirmAll] = useState(false)

  const apply = (next: PermissionMode): void => {
    void patchSettings({ permissionMode: next })
  }

  return (
    <section className="settings-section" data-testid="v3-security-settings">
      <SettingsGroup label={text.securityMode}>
        <SettingsRow
          block
          label={text.securityMode}
          description={mode === 'all' ? text.securityModeAllDesc : text.securityModeDangerDesc}
        >
          <Segmented
            label={text.securityMode}
            value={mode}
            options={PERMISSION_MODES.map((item) => ({
              value: item,
              label: item === 'danger' ? text.securityModeDanger : text.securityModeAll,
              testId: `v3-security-mode-${item}`
            }))}
            onChange={(value) => {
              if (value === mode) return
              if (permissionNeedsConfirm(value)) setConfirmAll(true)
              else apply(value)
            }}
          />
        </SettingsRow>

        <SettingsRow label={text.securityDangerConfirm} description={text.securityDangerConfirmDesc}>
          <span className="settings-value" data-testid="v3-security-danger-note">
            {mode === 'danger' ? text.enabled : '—'}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={text.securityOutside}>
        <SettingsRow
          label={text.securityOutside}
          description={mode === 'all' ? text.securityOutsideDisabled : text.securityOutsideDesc}
        >
          <Switch
            aria-label={text.securityOutside}
            isSelected={outside}
            isDisabled={mode === 'all'}
            onChange={(on) => void patchSettings({ guardOutsideWrites: on })}
            data-testid="v3-security-outside"
          />
        </SettingsRow>

        <SettingsRow block label={text.securityAllowRoots} description={text.securityAllowRootsDesc}>
          <AllowRootsList
            roots={roots}
            emptyText={text.securityAllowRootsEmpty}
            removeText={text.securityAllowRootsRemove}
            onRemove={(path) => void removeGuardAllowRoot(path)}
          />
        </SettingsRow>
      </SettingsGroup>

      <PiProjectTrustGroup />

      <ModalOverlay className="settings-confirm-overlay" isOpen={confirmAll} onOpenChange={setConfirmAll}>
        <Modal className="settings-confirm-modal">
          <Dialog className="settings-confirm" title={text.securityAllConfirmTitle} aria-label={text.securityAllConfirmTitle}>
            <p className="settings-row__desc">{text.securityAllConfirmBody}</p>
            <div className="settings-actions">
              <Button variant="secondary" size="sm" onPress={() => setConfirmAll(false)}>
                {text.cancel}
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="v3-security-all-confirm"
                onPress={() => {
                  setConfirmAll(false)
                  apply('all')
                }}
              >
                {text.securityAllConfirmContinue}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}
