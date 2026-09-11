import type { SVGProps } from 'react'
import { ICON_SPRITE, type IconName } from './sprite'

export type { IconName }
export { ICON_NAMES } from './sprite'

/**
 * 图标：reicon（MIT），25 个 symbol 由 `npm run icons` 从设计稿抽出。
 *
 * 这里渲染的是「引用」（<use href="#i-x">），
 * 真正定义 symbol 的 sprite 由 <IconSprite /> 在应用根部挂一次。
 */
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

/** 挂在 App 根部一次即可；display:none，不占布局 */
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
