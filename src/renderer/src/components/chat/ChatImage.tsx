import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { classifyLink } from '../../../../shared/links'

export function ChatImage({
  src,
  alt,
  sourceCwd,
  className
}: {
  src: string
  alt?: string
  sourceCwd?: string
  className?: string
}) {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const openBrowser = useStore((s) => s.openBrowser)
  const target = src.startsWith('data:') ? null : classifyLink(src)
  const open =
    target?.kind === 'file'
      ? () => void previewFile(target.path, undefined, sourceCwd)
      : target?.kind === 'url'
        ? () => void openBrowser(target.url)
        : undefined
  return (
    <img
      src={src}
      alt={alt || (open ? t('chat.imageOpen') : '')}
      className={[className, open ? 'chat-image-open' : ''].filter(Boolean).join(' ') || undefined}
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
