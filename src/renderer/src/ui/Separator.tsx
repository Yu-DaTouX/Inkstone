import {
  Separator as RACSeparator,
  type SeparatorProps as RACSeparatorProps
} from 'react-aria-components'
import { cx } from './cx'

export interface SeparatorProps extends RACSeparatorProps {
  /** 走线方向，默认 `horizontal`（一条水平分隔线）。 */
  orientation?: 'horizontal' | 'vertical'
}

/** 分隔线。优先用表面明度分隔，必须用线时才用它。 */
export function Separator({ orientation = 'horizontal', className, ...props }: SeparatorProps) {
  return (
    <RACSeparator
      {...props}
      orientation={orientation}
      className={cx('ui-separator', orientation === 'vertical' && 'ui-separator--vertical', className)}
    />
  )
}
