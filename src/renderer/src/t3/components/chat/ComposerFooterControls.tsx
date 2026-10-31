import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'
import { memo, useId, useRef, useState } from 'react'
import type { PermissionMode } from '../../../../../shared/approval'
import type { RuntimeModeOption } from '../../adapters/composer-permissions'
import { useT } from '../../../i18n'
import { Button } from '../ui/button'
import { Popover, PopoverPopup } from '../ui/popover'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { composerFloatingLayerProps } from './composerEventScope'
import { runtimeModeIcons } from './runtimeModeConfig'
import { cn } from '../../lib/utils'

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
}) {
  const t = useT()
  const size = props.size ?? 'sm'
  const accessDisplay = props.accessDisplay ?? 'label'
  const buttonRef = useRef<HTMLButtonElement>(null)
  const unrestricted = props.runtimeMode === 'all'
  const Icon = unrestricted ? ShieldOffIcon : ShieldCheckIcon
  const fullLabel = t(`permission.label.${props.runtimeMode}` as 'permission.label.danger')
  const description = t(`permission.hint.${props.runtimeMode}` as 'permission.hint.danger')
  const toggleHint = t('permission.toggle')
  const confirmOpen = props.pendingMode === 'all' && !props.hidden

  if (accessDisplay === 'hidden') return null

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              ref={buttonRef}
              data-composer-shortcut="composer.mode"
              data-composer-permission-trigger="true"
              data-permission-mode={props.runtimeMode}
              size={size}
              className={cn(
                'aspect-square px-0 text-(--fg2) hover:text-foreground [&_svg[data-composer-control-icon]]:text-current',
                size === 'xs' ? 'w-7 sm:w-6' : 'w-7'
              )}
              aria-label={`${t('permission.title')}: ${fullLabel}. ${toggleHint}`}
              onClick={() => props.onRuntimeModeChange(unrestricted ? 'danger' : 'all')}
            />
          }
        >
          <ComposerControlIcon icon={Icon} size={size} />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="flex flex-col gap-0.5">
            <span>{`${t('permission.title')}: ${fullLabel}`}</span>
            <span className="text-muted-foreground text-xs">{`${description} · ${toggleHint}`}</span>
          </span>
        </TooltipPopup>
      </Tooltip>
      <Popover
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) props.onCancelPending()
        }}
      >
        <PopoverPopup
          anchor={buttonRef}
          side="top"
          align="start"
          sideOffset={8}
          data-composer-permission-confirm="true"
          {...composerFloatingLayerProps}
        >
          <div className="grid w-60 gap-2.5">
            <div className="grid gap-0.5">
              <div className="font-medium text-sm">{t('permission.confirmAll.title')}</div>
              <div className="text-muted-foreground text-xs">{t('permission.confirmAll.desc')}</div>
            </div>
            <div className="flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={props.onCancelPending}>
                {t('ui.cancel')}
              </Button>
              <Button
                size="xs"
                autoFocus
                className="bg-(--stall) text-white hover:bg-(--stall)/90"
                onClick={props.onConfirmPending}
              >
                {t('permission.confirmAll.confirm')}
              </Button>
            </div>
          </div>
        </PopoverPopup>
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
