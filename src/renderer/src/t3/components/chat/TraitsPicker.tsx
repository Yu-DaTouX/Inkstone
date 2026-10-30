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
import { EffortSlider } from './EffortSlider'
import { focusRequestedPermission } from './composerEventScope'
import { useComposerMenuState } from './useComposerMenuState'

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
  triggerClassName?: string
  extraMenuContent?: ReactNode
  extraMenuOwnsModeShortcut?: boolean
  extraMenuHint?: string
}) {
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled || traits.busy)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { display } = traits
  const triggerLabel = display.label

  if (isComposerOwned) {
    return (
      <EffortSlider
        traits={traits}
        size={size}
        disabled={disabled || traits.busy}
        hidden={hidden}
        {...(triggerClassName ? { className: triggerClassName } : {})}
        {...(extraMenuContent ? { extraMenuContent } : {})}
        {...(extraMenuOwnsModeShortcut ? { extraMenuOwnsModeShortcut } : {})}
        {...(extraMenuHint ? { extraMenuHint } : {})}
      />
    )
  }

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
                  aria-label={triggerLabel}
                  size={size}
                  className={cn('shrink-0 whitespace-nowrap', triggerClassName)}
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={GaugeIcon} size={size} />
          <span data-composer-control-label>{triggerLabel}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
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
