import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'

export function MessageImage({
  src,
  alt,
  sourceCwd,
  className
}: {
  src: string
  alt?: string
  sourceCwd?: string
  className?: string
}): JSX.Element {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const openLink = useStore((s) => s.openLink)
  const target = src.startsWith('data:') ? null : classifyLink(src)
  const open =
    target?.kind === 'file'
      ? (): void => void previewFile(target.path, undefined, sourceCwd)
      : target?.kind === 'url'
        ? (): void => void openLink(target.url)
        : undefined
  return (
    <img
      src={src}
      alt={alt || (open ? t('chat.imageOpen') : '')}
      className={[className, open ? 'v3-img-open' : ''].filter(Boolean).join(' ') || undefined}
      loading="lazy"
      decoding="async"
      title={open ? t('chat.imageOpen') : undefined}
      onClick={open}
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    />
  )
}
