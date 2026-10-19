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
        {description != null ? <span className="ui-setting-row__desc">{description}</span> : null}
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
