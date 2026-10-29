import { useEffect, useState } from 'react'
import { SiteIcon } from '../../../ui/SiteIcon'
import { domainOf, siteLabel, siteTone } from './model'

export function WebsiteIcon({ url, className }: { url: string; className?: string }) {
  const domain = domainOf(url)
  let origin = ''
  try { origin = new URL(url).origin } catch {}
  const [icon, setIcon] = useState<{ origin: string; src: string | null } | null>(null)
  useEffect(() => {
    let current = true
    if (origin) void window.yan.searchOps.siteIcon(`${origin}/`).then((src) => {
      if (current) setIcon({ origin, src })
    }).catch(() => {})
    return () => { current = false }
  }, [origin])
  return <SiteIcon name={siteLabel(domain) || domain} src={icon?.origin === origin ? icon.src : null} tone={siteTone(domain)} className={className} />
}
