import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import { CollapsibleChevron } from './Collapsible'

interface RowSlots {
  icon?: ReactNode
  trailing?: ReactNode
  description?: ReactNode
  children: ReactNode
  muted?: boolean
  variant?: 'default' | 'field'
}

function RowContent({ icon, trailing, description, children }: Pick<RowSlots, 'icon' | 'trailing' | 'description' | 'children'>) {
  return (
    <>
      {icon != null ? (
        <span className="ui-row__lead" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {description != null ? (
        <span className="ui-row__text">
          <span className="ui-row__label">{children}</span>
          <span className="ui-row__desc">{description}</span>
        </span>
      ) : (
        <span className="ui-row__label">{children}</span>
      )}
      {trailing != null ? <span className="ui-row__trail">{trailing}</span> : null}
    </>
  )
}

function rowClass(variant: RowSlots['variant'], description: ReactNode, ...extra: (string | false | undefined)[]): string {
  return cx('ui-row', variant === 'field' && 'ui-row--field', description != null && 'ui-row--two-line', ...extra)
}

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>, RowSlots {
  current?: boolean
  signal?: 'ask'
  hoverHighlight?: boolean
  accessory?: ReactNode
}

export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(function ListRow(
  { icon, trailing, description, children, current, muted, signal, hoverHighlight = true, accessory, variant = 'default', className, type = 'button', ...rest },
  ref
) {
  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-current={current ? 'true' : rest['aria-current']}
      data-muted={muted ? '' : undefined}
      data-signal={signal}
      data-no-hover={hoverHighlight ? undefined : ''}
      className={rowClass(variant, description, className)}
    >
      <RowContent icon={icon} trailing={trailing} description={description}>
        {children}
      </RowContent>
    </button>
  )
  if (accessory == null) return button
  return (
    <div className="ui-row-frame" data-no-hover={hoverHighlight ? undefined : ''}>
      {button}
      <span className="ui-row__accessory">{accessory}</span>
    </div>
  )
})

export interface ListRowStaticProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'>, RowSlots {}

export const ListRowStatic = forwardRef<HTMLDivElement, ListRowStaticProps>(function ListRowStatic(
  { icon, trailing, description, children, muted, variant = 'default', className, ...rest },
  ref
) {
  return (
    <div
      {...rest}
      ref={ref}
      data-muted={muted ? '' : undefined}
      data-no-hover=""
      className={rowClass(variant, description, 'ui-row--static', className)}
    >
      <RowContent icon={icon} trailing={trailing} description={description}>
        {children}
      </RowContent>
    </div>
  )
})

export interface TreeRowProps extends Omit<ListRowProps, 'accessory' | 'description'> {
  depth?: number
  expanded?: boolean
}

export const TreeRow = forwardRef<HTMLButtonElement, TreeRowProps>(function TreeRow(
  { depth = 0, expanded, icon, trailing, children, current, muted, hoverHighlight = true, variant = 'default', className, style, type = 'button', ...rest },
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
      data-no-hover={hoverHighlight ? undefined : ''}
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
