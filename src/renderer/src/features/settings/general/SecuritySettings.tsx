import { useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { PERMISSION_MODES, normalizePermissionMode, type PermissionMode } from '../../../../../shared/approval'
import { useStore } from '../../../state/store'
import { Button, ConfirmDialog, EmptyState, MiddleTruncate, Switch } from '../../../ui'
import { generalText } from './general-text'
import { permissionNeedsConfirm } from './general-model'
import { SettingsGroup, SettingsRow, Segmented } from '../root/controls'
import { settingsText } from '../settings-text'
import { PiProjectTrustGroup } from './PiNativeSettings'
import { AllowedSitesDialog } from '../../browser/AllowedSitesDialog'

export interface AllowRootsListProps {
  roots: readonly string[]
  emptyText: string
  removeText: string
  onRemove: (path: string) => void
}

export function AllowRootsList({ roots, emptyText, removeText, onRemove }: AllowRootsListProps): ReactElement {
  if (roots.length === 0) {
    return (
      <EmptyState size="sm" align="start" inset="none" className="settings-list-empty" title={emptyText} data-testid="v3-security-roots-empty" />
    )
  }
  return (
    <ul className="settings-roots" data-testid="v3-security-roots">
      {roots.map((path) => (
        <li className="settings-root" key={path} data-testid="v3-security-root">
          <MiddleTruncate className="settings-root__path" value={path} />
          <Button variant="danger" onPress={() => onRemove(path)}>
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
  const labels = settingsText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const removeGuardAllowRoot = useStore((s) => s.removeGuardAllowRoot)
  const mode = normalizePermissionMode(settings?.permissionMode)
  const outside = settings?.guardOutsideWrites === true
  const roots = settings?.guardAllowRoots ?? []
  const [confirmAll, setConfirmAll] = useState(false)
  const [sitesOpen, setSitesOpen] = useState(false)

  const apply = (next: PermissionMode): void => {
    void patchSettings({ permissionMode: next })
  }

  return (
    <section className="settings-section" data-testid="v3-security-settings">
      <SettingsGroup title={labels.groupSecurityPermissions}>
        <SettingsRow
          settingId="security-permission-mode"
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

        <SettingsRow
          settingId="security-outside-writes"
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

        <SettingsRow
          block
          nested
          settingId="security-allow-roots"
          label={text.securityAllowRoots}
          description={text.securityAllowRootsDesc}
        >
          <AllowRootsList
            roots={roots}
            emptyText={text.securityAllowRootsEmpty}
            removeText={text.securityAllowRootsRemove}
            onRemove={(path) => void removeGuardAllowRoot(path)}
          />
        </SettingsRow>

        <SettingsRow
          settingId="security-remote-images"
          label={text.securityRemoteImages}
          description={text.securityRemoteImagesDesc}
        >
          <Button variant="secondary" onPress={() => setSitesOpen(true)} data-testid="v3-security-remote-images">
            {text.securityRemoteImagesManage}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <AllowedSitesDialog isOpen={sitesOpen} onClose={() => setSitesOpen(false)} />

      <PiProjectTrustGroup title={labels.groupSecurityProjects} />

      <ConfirmDialog
        overlayClassName="settings-confirm-overlay"
        isOpen={confirmAll}
        onOpenChange={setConfirmAll}
        title={text.securityAllConfirmTitle}
        description={text.securityAllConfirmBody}
        tone="danger"
        cancelLabel={text.cancel}
        confirmLabel={text.securityAllConfirmContinue}
        confirmTestId="v3-security-all-confirm"
        onConfirm={() => apply('all')}
      />
    </section>
  )
}
