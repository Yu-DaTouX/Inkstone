import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from './cx'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li'
  padding?: 'none' | 'sm' | 'md'
  interactive?: boolean
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Tag = 'div', padding = 'md', interactive, className, ...rest },
  ref
) {
  return (
    <Tag
      {...rest}
      ref={ref as never}
      className={cx('ui-card', `ui-card--pad-${padding}`, interactive && 'ui-card--interactive', className)}
    />
  )
})
