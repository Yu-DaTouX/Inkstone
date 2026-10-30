import { Globe2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/t3/lib/utils'

export function faviconUrlForOrigin(url: string | null): string | null {
  if (!url || url.length > 4096) return null
  try {
    const page = new URL(url)
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return null
    return new URL('/favicon.ico', page.origin).href
  } catch {
    return null
  }
}

export function FaviconImage(props: {
  sources: ReadonlyArray<string | null | undefined>
  fallback: ReactNode
  className?: string
}) {
  const sources = props.sources.filter((source): source is string => Boolean(source))
  return <FaviconImageAttempt key={sources.join('\0')} sources={sources} fallback={props.fallback} className={props.className} />
}

function FaviconImageAttempt(props: {
  sources: ReadonlyArray<string>
  fallback: ReactNode
  className?: string
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const source = props.sources.find((candidate) => !failed.has(candidate))
  if (!source) return <>{props.fallback}</>
  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={props.className}
      onError={() => setFailed((current) => new Set(current).add(source))}
    />
  )
}

export function PreviewFaviconIcon(props: {
  url: string | null
  capturedUrl?: string | null
  className?: string
}) {
  return (
    <FaviconImage
      sources={[props.capturedUrl, faviconUrlForOrigin(props.url)]}
      fallback={<Globe2 className={cn('size-3 shrink-0', props.className)} />}
      className={cn('size-3 shrink-0 rounded-sm object-contain', props.className)}
    />
  )
}
