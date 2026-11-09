import { memo, type ReactNode } from 'react'
import { GaugeIcon } from 'lucide-react'
import type { ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cx } from '../../../ui/cx'
import { Dialog, DialogTrigger } from 'react-aria-components'
import { ListBox, ListBoxItem, Popover, Separator, Tooltip, TooltipHint, TooltipTrigger } from '../../../ui'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { EffortSlider } from './EffortSlider'
import { ComposerMenuCloseProvider, useComposerMenuClose } from './composerMenuClose'
import { useComposerMenuState } from './useComposerMenuState'
import './ComposerControlMenus.css'

export function TraitsMenuContent({ traits }: { traits: ComposerTraitsAdapter }) {
  const { descriptor } = traits
  const closeMenu = useComposerMenuClose()
  return (
    <div role="group" aria-label={descriptor.label}>
      <div className="t3-traits__title">
        {descriptor.label}
      </div>
      <ListBox
        aria-label={descriptor.label}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={descriptor.currentValue ? [descriptor.currentValue] : []}
        onSelectionChange={(keys) => {
          const next = [...keys][0]
          if (next === undefined) return
          traits.select(String(next))
          closeMenu()
        }}
        className="t3-traits__list"
      >
        {descriptor.options.map((option) => (
          <ListBoxItem key={option.id} id={option.id} textValue={option.label}>
            <span className="t3-traits__option">
              <span className="t3-traits__option-head">
                <span className="t3-traits__option-label">{option.label}</span>
              </span>
              {option.description ? (
                <span className="t3-traits__option-desc">
                  {option.description}
                </span>
              ) : null}
            </span>
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
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
  onOpen,
  expanded
}: {
  traits: ComposerTraitsAdapter
  size?: ComposerControlSize
  hidden?: boolean
  disabled?: boolean
  isComposerOwned?: boolean
  triggerClassName?: string
  extraMenuContent?: ReactNode
  onOpen?: () => void
  expanded?: boolean
}) {
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled || traits.busy)
  const { display } = traits
  const triggerLabel = display.label

  if (isComposerOwned) {
    return (
      <EffortSlider
        traits={traits}
        size={size}
        disabled={disabled}
        hidden={hidden}
        onOpen={onOpen}
        expanded={expanded}
        {...(triggerClassName ? { className: triggerClassName } : {})}
      />
    )
  }

  return (
    <DialogTrigger
      isOpen={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled && !traits.busy)
      }}
    >
      <TooltipTrigger>
        <ComposerControl
          isDisabled={disabled || traits.busy}
          aria-label={triggerLabel}
          size={size}
          className={cx('t3-traits__trigger', triggerClassName)}
        >
          <ComposerControlIcon icon={GaugeIcon} size={size} />
          <span data-composer-control-label>{triggerLabel}</span>
        </ComposerControl>
        <Tooltip><TooltipHint label={triggerLabel} /></Tooltip>
      </TooltipTrigger>
      <Popover placement="top start">
        <Dialog aria-label={triggerLabel} className="t3-traits__dialog">
          <ComposerMenuCloseProvider value={() => setIsMenuOpen(false)}>
          <TraitsMenuContent traits={traits} />
          {extraMenuContent ? (
            <>
              <Separator />
              {extraMenuContent}
            </>
          ) : null}
          </ComposerMenuCloseProvider>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
})
