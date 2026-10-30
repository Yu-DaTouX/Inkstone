import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { memo, useId, useRef, useState } from 'react'
import type { PermissionMode } from '../../../../../shared/approval'
import type { RuntimeModeOption } from '../../adapters/composer-permissions'
import { useT } from '../../../i18n'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { focusRequestedPermission, useComposerMenuProps } from './composerEventScope'
import { runtimeModeIcons } from './runtimeModeConfig'
import { useComposerMenuState } from './useComposerMenuState'

const fallbackRuntimeModeOption: RuntimeModeOption = {
  mode: 'danger',
  label: '',
  description: '',
  icon: runtimeModeIcons.danger
}

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  runtimeMode: PermissionMode
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>
  size?: ComposerControlSize
  hidden?: boolean
  accessDisplay?: 'label' | 'icon' | 'hidden'
  emphasized?: boolean
  onRuntimeModeChange: (mode: PermissionMode) => void
}) {
  const t = useT()
  const size = props.size ?? 'sm'
  const accessDisplay = props.accessDisplay ?? 'label'
  const composerFloatingLayerProps = useComposerMenuProps()
  const [open, setOpen] = useComposerMenuState(props.hidden || props.accessDisplay === 'hidden')
  const permissionsChipRef = useRef<HTMLButtonElement>(null)
  const runtimeModeOption =
    props.runtimeModeOptions.find((option) => option.mode === props.runtimeMode) ??
    fallbackRuntimeModeOption
  const RuntimeModeIcon = runtimeModeOption.icon
  const permissionsTooltip = `${t('permission.title')}: ${runtimeModeOption.label}. ${runtimeModeOption.description}`

  if (accessDisplay === 'hidden') return null

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, permissionsChipRef.current)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={permissionsChipRef}
                  data-composer-shortcut="composer.mode"
                  size={size}
                  className="ps-1.5"
                  aria-label={`${t('permission.title')}: ${runtimeModeOption.label}`}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={RuntimeModeIcon}
            size={size}
            {...(props.emphasized ? { className: 'text-current' } : {})}
          />
          <span data-composer-control-label className={accessDisplay === 'icon' ? 'sr-only' : undefined}>
            {runtimeModeOption.label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{permissionsTooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.runtimeModeOptions}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
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
    <div data-composer-permissions className="grid w-72 gap-1.5 px-2 py-1.5">
      <div className="font-medium text-muted-foreground text-xs">{t('permission.title')}</div>
      <MenuPrimitive.RadioGroup
        aria-label={t('permission.title')}
        value={props.runtimeMode}
        onValueChange={(value: PermissionMode) => {
          if (value !== props.runtimeMode) props.onRuntimeModeChange(value)
        }}
        className="flex gap-0.5 rounded-lg bg-input/40 p-0.5"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
          )
          const index = items.findIndex((item) => item === document.activeElement)
          const next = items[index + (event.key === 'ArrowRight' ? 1 : -1)]
          if (index < 0 || !next) return
          event.preventDefault()
          event.stopPropagation()
          next.focus()
        }}
      >
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon
          return (
            <MenuPrimitive.RadioItem
              key={option.mode}
              value={option.mode}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.mode}`}
              closeOnClick
              onPointerEnter={() => setPreviewMode(option.mode)}
              onPointerLeave={() => setPreviewMode(null)}
              onFocus={() => setPreviewMode(option.mode)}
              onBlur={() => setPreviewMode(null)}
              className="flex h-6 flex-1 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none data-checked:bg-input/72 data-checked:text-foreground data-highlighted:text-foreground not-data-checked:data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <OptionIcon aria-hidden="true" className="size-3.5" />
            </MenuPrimitive.RadioItem>
          )
        })}
      </MenuPrimitive.RadioGroup>
      {props.runtimeModeOptions.map((option) => (
        <span key={option.mode} id={`${descriptionId}-${option.mode}`} className="sr-only">
          {option.description}
        </span>
      ))}
      <div className="grid gap-0.5" aria-hidden="true">
        <span
          className={
            shownMode === props.runtimeMode
              ? 'text-foreground text-sm'
              : 'text-muted-foreground text-sm'
          }
        >
          {shown.label}
        </span>
        <span className="min-h-8 text-muted-foreground text-xs leading-4">{shown.description}</span>
      </div>
    </div>
  )
}
