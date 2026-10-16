import type { SVGProps } from 'react'
import { ICON_SPRITE, type IconName } from './sprite'

export type { IconName }
export { ICON_NAMES } from './sprite'

export function Icon({
  name,
  size = 14,
  className,
  ...rest
}: { name: IconName; size?: 12 | 14 | 16; className?: string } & Omit<
  SVGProps<SVGSVGElement>,
  'name'
>) {
  return (
    <svg
      className={['ico', size !== 14 && `ico-${size}`, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <use href={`#i-${name}`} />
    </svg>
  )
}

export function IconSprite() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'none' }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_SPRITE }}
    />
  )
}
