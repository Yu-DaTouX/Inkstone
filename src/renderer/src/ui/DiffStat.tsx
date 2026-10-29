import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export interface DiffStatProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  added: number
  removed: number
  hideZero?: boolean
  size?: 'sm' | 'md'
}

export function DiffStat({ added, removed, hideZero = false, size = 'sm', className, ...rest }: DiffStatProps) {
  const showAdded = !hideZero || added > 0
  const showRemoved = !hideZero || removed > 0
  if (!showAdded && !showRemoved) return null
  return (
    <span {...rest} className={cx('ui-diffstat', `ui-diffstat--${size}`, className)}>
      {showAdded ? <span className="ui-diffstat__add">+{added}</span> : null}
      {showRemoved ? <span className="ui-diffstat__del">{'\u2212'}{removed}</span> : null}
    </span>
  )
}
