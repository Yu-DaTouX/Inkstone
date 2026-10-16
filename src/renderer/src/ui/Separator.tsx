import {
  Separator as RACSeparator,
  type SeparatorProps as RACSeparatorProps
} from 'react-aria-components'
import { cx } from './cx'

export interface SeparatorProps extends RACSeparatorProps {
  orientation?: 'horizontal' | 'vertical'
}

export function Separator({ orientation = 'horizontal', className, ...props }: SeparatorProps) {
  return (
    <RACSeparator
      {...props}
      orientation={orientation}
      className={cx('ui-separator', orientation === 'vertical' && 'ui-separator--vertical', className)}
    />
  )
}
