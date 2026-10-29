import { useState } from 'react'
import { avatarInitial } from './Avatar'
import { cx } from './cx'
import './SiteIcon.css'

export interface SiteIconProps {
  name: string
  src?: string | null
  tone?: number
  className?: string
}

export function SiteIcon({ name, src, tone = 0, className }: SiteIconProps) {
  const [loaded, setLoaded] = useState('')
  const [failed, setFailed] = useState('')
  const image = src && failed !== src ? src : null
  return (
    <span className={cx('ui-site-icon', className)} data-tone={tone} data-loaded={!!image && loaded === image} aria-hidden="true">
      <span className="ui-site-icon__fallback">{avatarInitial(name)}</span>
      {image ? <img src={image} alt="" width={24} height={24} decoding="async" draggable={false} onLoad={() => setLoaded(image)} onError={() => setFailed(image)} /> : null}
    </span>
  )
}
