import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { cx } from './cx'

export interface SettingRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode
  description?: ReactNode
  block?: boolean
  indent?: boolean
  children?: ReactNode
}

export function SettingRow({ label, description, block, indent, className, children, ...rest }: SettingRowProps): ReactElement {
  return (
    <div
      {...rest}
      className={cx('ui-setting-row', className)}
      data-block={block ? '1' : '0'}
      data-indent={indent ? '1' : undefined}
    >
      <div className="ui-setting-row__text">
        <span className="ui-setting-row__label">{label}</span>
        {description != null ? <div className="ui-setting-row__desc">{description}</div> : null}
      </div>
      {children != null ? <div className="ui-setting-row__ctl">{children}</div> : null}
    </div>
  )
}

export interface SettingRowsProps extends HTMLAttributes<HTMLDivElement> {
  label?: string
}

export function SettingRows({ label, className, children, ...rest }: SettingRowsProps): ReactElement {
  return (
    <div {...rest} className={cx('ui-setting-rows', className)} role="group" aria-label={label}>
      {children}
    </div>
  )
}

export interface SettingSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  plain?: boolean
}

export function SettingSection({
  title,
  description,
  actions,
  plain,
  className,
  children,
  ...rest
}: SettingSectionProps): ReactElement {
  const head = title != null || description != null || actions != null
  return (
    <section {...rest} className={cx('ui-setting-section', className)}>
      {head ? (
        <header className="ui-setting-section__head">
          <div className="ui-setting-section__titles">
            {title != null ? <h3 className="ui-setting-section__title">{title}</h3> : null}
            {description != null ? <p className="ui-setting-section__desc">{description}</p> : null}
          </div>
          {actions != null ? <div className="ui-setting-section__actions">{actions}</div> : null}
        </header>
      ) : null}
      {plain ? children : <div className="ui-setting-rows">{children}</div>}
    </section>
  )
}
