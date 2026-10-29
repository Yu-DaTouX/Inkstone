import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { cx } from './cx'
import { CollapsibleChevron } from './Collapsible'

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: ReactNode
  trailing?: ReactNode
  children: ReactNode
  current?: boolean
  muted?: boolean
  variant?: 'default' | 'field'
}

export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(function ListRow(
  { icon, trailing, children, current, muted, variant = 'default', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-current={current ? 'true' : rest['aria-current']}
      data-muted={muted ? '' : undefined}
      className={cx('ui-row', variant === 'field' && 'ui-row--field', className)}
    >
      {icon != null ? (
        <span className="ui-row__lead" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ui-row__label">{children}</span>
      {trailing != null ? <span className="ui-row__trail">{trailing}</span> : null}
    </button>
  )
})

export interface TreeRowProps extends ListRowProps {
  depth?: number
  expanded?: boolean
}

export const TreeRow = forwardRef<HTMLButtonElement, TreeRowProps>(function TreeRow(
  { depth = 0, expanded, icon, trailing, children, current, muted, variant = 'default', className, style, type = 'button', ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-current={current ? 'true' : rest['aria-current']}
      aria-expanded={expanded ?? rest['aria-expanded']}
      data-muted={muted ? '' : undefined}
      style={{ ...style, '--tree-depth': depth } as CSSProperties}
      className={cx('ui-row', 'ui-tree-row', variant === 'field' && 'ui-row--field', className)}
    >
      <span className="ui-tree-row__twist" aria-hidden="true">
        {expanded === undefined ? null : <CollapsibleChevron expanded={expanded} />}
      </span>
      {icon != null ? (
        <span className="ui-tree-row__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ui-row__label">{children}</span>
      {trailing != null ? <span className="ui-row__trail">{trailing}</span> : null}
    </button>
  )
})
