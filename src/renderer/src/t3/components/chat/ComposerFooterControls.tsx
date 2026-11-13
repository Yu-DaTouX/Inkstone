import { Dialog } from 'react-aria-components'
import { ShieldCheckIcon, ShieldOffIcon } from '../../../ui/icons'
import { memo, useId, useRef, useState } from 'react'
import type { PermissionMode } from '../../../../../shared/approval'
import type { RuntimeModeOption } from '../../adapters/composer-permissions'
import { useT } from '../../../i18n'
import { Button, Popover, Toggle, ToggleGroup, TooltipTrigger, Tooltip, TooltipHint } from '../../../ui'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { composerFloatingLayerProps } from './composerEventScope'
import { runtimeModeIcons } from './runtimeModeConfig'
import { cx } from '../../../ui/cx'
import './ComposerFooterControls.css'

const fallbackRuntimeModeOption: RuntimeModeOption = {
  mode: 'danger',
  label: '',
  description: '',
  icon: runtimeModeIcons.danger
}

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  runtimeMode: PermissionMode
  size?: ComposerControlSize
  hidden?: boolean
  accessDisplay?: 'label' | 'icon' | 'hidden'
  pendingMode: PermissionMode | null
  onRuntimeModeChange: (mode: PermissionMode) => void
  onConfirmPending: () => void
  onCancelPending: () => void
  onOpen?: () => void
}) {
  const t = useT()
  const size = props.size ?? 'sm'
  const accessDisplay = props.accessDisplay ?? 'label'
  const buttonRef = useRef<HTMLButtonElement>(null)
  const unrestricted = props.runtimeMode === 'all'
  const Icon = unrestricted ? ShieldOffIcon : ShieldCheckIcon
  const fullLabel = t(`permission.label.${props.runtimeMode}` as 'permission.label.danger')
  const toggleHint = props.onOpen ? '' : t('permission.toggle')
  const confirmOpen = !props.onOpen && props.pendingMode === 'all' && !props.hidden

  if (accessDisplay === 'hidden') return null

  return (
    <>
      <TooltipTrigger>
        <ComposerControl ref={buttonRef} data-composer-shortcut="composer.mode" data-composer-permission-trigger="true" data-permission-mode={props.runtimeMode} size={size} className={cx(
                't3-permission-toggle',
                size === 'xs' && 't3-permission-toggle--xs'
              )} aria-label={toggleHint ? `${t('permission.title')}: ${fullLabel}. ${toggleHint}` : `${t('permission.title')}: ${fullLabel}`} onPress={() => (props.onOpen ? props.onOpen() : props.onRuntimeModeChange(unrestricted ? 'danger' : 'all'))}>
          <ComposerControlIcon icon={Icon} size={size} />
        </ComposerControl>
        <Tooltip><TooltipHint label={toggleHint ? `${t('permission.title')}: ${fullLabel} · ${toggleHint}` : `${t('permission.title')}: ${fullLabel}`} /></Tooltip>
      </TooltipTrigger>
      <Popover
        triggerRef={buttonRef}
        isOpen={confirmOpen}
        onOpenChange={(next) => {
          if (!next) props.onCancelPending()
        }}
        variant="panel"
        placement="top start"
        offset={8}
        data-composer-permission-confirm="true"
        {...composerFloatingLayerProps}
      >
        <Dialog aria-label={t('permission.confirmAll.title')} >
          <div className="t3-permission-confirm">
            <div className="t3-permission-confirm__text">
              <div className="t3-permission-confirm__title">{t('permission.confirmAll.title')}</div>
              <div className="t3-permission-confirm__desc">{t('permission.confirmAll.desc')}</div>
            </div>
            <div className="t3-permission-confirm__actions">
              <Button data-t3-btn variant="ghost" onPress={props.onCancelPending}>
                {t('ui.cancel')}
              </Button>
              <Button data-t3-btn variant="primary" onPress={props.onConfirmPending} autoFocus className="t3-permission-confirm__ok">
                {t('permission.confirmAll.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>
      </Popover>
    </>
  )
})

export function ComposerPermissionsSection(props: {
  runtimeMode: PermissionMode
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>
  onRuntimeModeChange: (mode: PermissionMode) => void
}) {
  const t = useT()
  const [previewMode, setPreviewMode] = useState<PermissionMode | null>(null)
  const shownMode = previewMode ?? props.runtimeMode
  const shown =
    props.runtimeModeOptions.find((option) => option.mode === shownMode) ??
    fallbackRuntimeModeOption
  const descriptionId = useId()
  return (
    <div data-composer-permissions className="t3-permissions">
      <div className="t3-permissions__title">{t('permission.title')}</div>
      <ToggleGroup
        aria-label={t('permission.title')}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[props.runtimeMode]}
        onSelectionChange={(keys) => {
          const value = [...keys][0] as PermissionMode | undefined
          if (value !== undefined && value !== props.runtimeMode) props.onRuntimeModeChange(value)
        }}
        className="t3-permissions__group"
      >
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon
          return (
            <Toggle
              key={option.mode}
              id={option.mode}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.mode}`}
              onFocus={() => setPreviewMode(option.mode)}
              onBlur={() => setPreviewMode(null)}
              className="t3-permissions__option"
            >
              <OptionIcon aria-hidden="true" className="t3-icon--sm" />
            </Toggle>
          )
        })}
      </ToggleGroup>
      {props.runtimeModeOptions.map((option) => (
        <span key={option.mode} id={`${descriptionId}-${option.mode}`} className="sr-only">
          {option.description}
        </span>
      ))}
      <div className="t3-permissions__summary" aria-hidden="true">
        <span
          className={cx('t3-permissions__label', shownMode === props.runtimeMode && 't3-permissions__label--current')}
        >
          {shown.label}
        </span>
        <span className="t3-permissions__desc">{shown.description}</span>
      </div>
    </div>
  )
}
