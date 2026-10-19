import { cx } from './cx'

export interface AvatarProps {
  name: string
  className?: string
}

export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? ''
  return first.toLocaleUpperCase()
}

export function Avatar({ name, className }: AvatarProps) {
  return (
    <span className={cx('ui-avatar', className)} aria-hidden="true">
      {avatarInitial(name)}
    </span>
  )
}
