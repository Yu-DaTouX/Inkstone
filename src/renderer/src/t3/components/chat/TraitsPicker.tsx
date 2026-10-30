import { memo, useRef, type ReactNode } from 'react'
import { GaugeIcon } from 'lucide-react'
import type { ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cn } from '../../lib/utils'
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger
} from '../ui/menu'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { EffortGlyph, resolveEffortGlyph } from './EffortGlyph'
import { focusRequestedPermission, useComposerMenuProps } from './composerEventScope'
import { useComposerMenuState } from './useComposerMenuState'

export type EffortDisplay = 'label' | 'glyph'

export function TraitsMenuContent({ traits }: { traits: ComposerTraitsAdapter }) {
  const { descriptor } = traits
  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        {descriptor.label}
      </div>
      <MenuRadioGroup
        value={descriptor.currentValue ?? ''}
        onValueChange={(value) => {
          if (typeof value === 'string') traits.select(value)
        }}
      >
        {descriptor.options.map((option) => (
          <MenuRadioItem key={option.id} value={option.id} hideIndicator closeOnClick>
            <span className="flex w-full min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{option.label}</span>
              </span>
              {option.description ? (
                <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                  {option.description}
                </span>
              ) : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  )
}

export const TraitsPicker = memo(function TraitsPicker({
  traits,
  size = 'sm',
  hidden = false,
  disabled = false,
  isComposerOwned = false,
  effortDisplay = 'label',
  triggerClassName,
  extraMenuContent,
  extraMenuOwnsModeShortcut,
  extraMenuHint
}: {
  traits: ComposerTraitsAdapter
  size?: ComposerControlSize
  hidden?: boolean
  disabled?: boolean
  isComposerOwned?: boolean
  effortDisplay?: EffortDisplay
  triggerClassName?: string
  extraMenuContent?: ReactNode
  extraMenuOwnsModeShortcut?: boolean
  extraMenuHint?: string
}) {
  const composerFloatingLayerProps = useComposerMenuProps()
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled || traits.busy)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { descriptor, display } = traits
  const triggerLabel = display.label
  const triggerDescription = isComposerOwned
    ? [`${descriptor.label}: ${triggerLabel}`, extraMenuHint].filter(Boolean).join(' · ')
    : triggerLabel
  const effortGlyph = isComposerOwned
    ? resolveEffortGlyph(descriptor, descriptor.currentValue)
    : null
  const effortWord = effortGlyph
    ? (effortGlyph.special ?? (effortDisplay === 'label' ? effortGlyph.label : null))
    : null

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled && !traits.busy)
      }}
      onOpenChangeComplete={(open) => focusRequestedPermission(open, triggerRef.current)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={triggerRef}
                  disabled={disabled || traits.busy}
                  aria-label={triggerDescription}
                  data-composer-shortcut={
                    isComposerOwned
                      ? extraMenuOwnsModeShortcut
                        ? 'composer.effort composer.mode'
                        : 'composer.effort'
                      : undefined
                  }
                  size={size}
                  className={cn(
                    'shrink-0 whitespace-nowrap',
                    triggerClassName,
                    isComposerOwned && (effortWord !== null ? '-ms-1 ps-0' : '-ms-1 ps-0.5'),
                    effortWord !== null &&
                      'text-muted-foreground hover:text-foreground data-pressed:text-foreground data-popup-open:text-foreground'
                  )}
                />
              }
            />
          }
        >
          {effortGlyph ? (
            <span className="flex items-center gap-1.5">
              {effortWord === null ? (
                <EffortGlyph count={effortGlyph.count} filled={effortGlyph.filled} size={size} />
              ) : null}
              {effortWord !== null ? (
                <>
                  <span data-composer-control-label>{effortWord}</span>
                  <GaugeIcon
                    aria-hidden="true"
                    data-composer-control-compact-icon
                    className="invisible absolute size-3.5"
                  />
                </>
              ) : (
                <span data-composer-control-label className="sr-only">
                  {triggerLabel}
                </span>
              )}
            </span>
          ) : (
            <>
              <ComposerControlIcon icon={GaugeIcon} size={size} />
              <span data-composer-control-label>{triggerLabel}</span>
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerDescription}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...(isComposerOwned ? composerFloatingLayerProps : {})}>
        <TraitsMenuContent traits={traits} />
        {extraMenuContent ? (
          <>
            <MenuDivider />
            {extraMenuContent}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  )
})
