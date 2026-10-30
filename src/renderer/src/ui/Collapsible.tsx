import { forwardRef, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button as RACButton,
  Disclosure as RACDisclosure,
  DisclosurePanel as RACDisclosurePanel,
  DisclosureStateContext,
  composeRenderProps,
  type ButtonProps as RACButtonProps,
  type DisclosurePanelProps as RACDisclosurePanelProps,
  type DisclosureProps as RACDisclosureProps
} from 'react-aria-components'
import { ChevronRight } from 'lucide-react'
import { cx } from './cx'
import { CHEVRON_ICON_SIZE } from './sizes'
import { motionAllowed, motionMs } from './motion-hooks'

export type CollapsibleProps = RACDisclosureProps

export const Collapsible = forwardRef<HTMLDivElement, CollapsibleProps>(function Collapsible({ className, ...props }, ref) {
  return <RACDisclosure {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-collapsible', cn))} />
})

export interface CollapsiblePanelProps extends RACDisclosurePanelProps {
  animated?: boolean
}

export const CollapsiblePanel = forwardRef<HTMLDivElement, CollapsiblePanelProps>(function CollapsiblePanel(
  { className, animated, children, ...props },
  ref
) {
  const expanded = useContext(DisclosureStateContext)?.isExpanded ?? true
  const kept = useRef<RACDisclosurePanelProps['children']>(children)
  const [closing, setClosing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [seen, setSeen] = useState(expanded)
  if (seen !== expanded) {
    const allowed = !!animated && motionAllowed()
    setSeen(expanded)
    setClosing(!expanded && allowed)
    setOpening(expanded && allowed)
  }
  if (expanded) kept.current = children
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => setClosing(false), motionMs('base') + 50)
    return () => window.clearTimeout(timer)
  }, [closing])
  const shown = animated && !expanded && closing && children == null ? kept.current : children
  return (
    <RACDisclosurePanel
      {...props}
      ref={ref}
      data-animated={animated ? 'true' : undefined}
      data-opening={opening ? '' : undefined}
      className={composeRenderProps(className, (cn) => cx('ui-collapsible__panel', cn))}
    >
      {shown}
    </RACDisclosurePanel>
  )
})

export interface CollapsibleChevronProps {
  expanded?: boolean
  className?: string
}

export function CollapsibleChevron({ expanded, className }: CollapsibleChevronProps) {
  return (
    <span
      className={cx('ui-chevron', className)}
      data-expanded={expanded === undefined ? undefined : expanded ? 'true' : 'false'}
      aria-hidden="true"
    >
      <ChevronRight size={CHEVRON_ICON_SIZE} />
    </span>
  )
}

export interface CollapsibleHeaderProps extends Omit<RACButtonProps, 'slot' | 'children' | 'className'> {
  children: ReactNode
  className?: string
  icon?: ReactNode
  accessory?: ReactNode
  actions?: ReactNode
  tone?: 'muted' | 'emphasized'
  chevron?: 'start' | 'end' | 'none'
  rule?: boolean
  rowHover?: boolean
  size?: 'md' | 'compact'
}

export function CollapsibleHeader({
  children,
  icon,
  accessory,
  actions,
  tone = 'muted',
  chevron = 'start',
  rule = false,
  rowHover = false,
  size = 'md',
  className,
  ...props
}: CollapsibleHeaderProps) {
  return (
    <div className={cx('ui-collapsible__head', className)} data-tone={tone} data-size={size === 'compact' ? 'compact' : undefined} data-row-hover={rowHover ? '' : undefined}>
      <RACButton {...props} slot="trigger" className="ui-collapsible__trigger">
        {chevron === 'start' ? <CollapsibleChevron className="ui-collapsible__chevron" /> : null}
        {icon != null ? (
          <span className="ui-collapsible__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="ui-collapsible__label">{children}</span>
        {rule ? <span className="ui-collapsible__rule" aria-hidden="true" /> : null}
        {accessory != null ? <span className="ui-collapsible__accessory">{accessory}</span> : null}
        {chevron === 'end' ? <CollapsibleChevron className="ui-collapsible__chevron" /> : null}
      </RACButton>
      {actions != null ? <span className="ui-collapsible__actions">{actions}</span> : null}
    </div>
  )
}
