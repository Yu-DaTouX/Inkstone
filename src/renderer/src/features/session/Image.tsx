import { useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { openMessageMenu, type MessageMenuItem } from './message-menu'
import { ImageViewer } from '../composer/image-viewer'

function imageName(src: string, alt?: string): string {
  const label = (alt ?? '').trim()
  if (label && label.length <= 80) return label
  const last = src.split(/[\\/]/).pop() ?? ''
  return last && !last.startsWith('data:') ? last : 'image'
}

async function pngDataUrl(img: HTMLImageElement): Promise<string | null> {
  const width = img.naturalWidth || img.width
  const height = img.naturalHeight || img.height
  if (!width || !height) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(img, 0, 0, width, height)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export function MessageImage({
  src,
  alt,
  sourceCwd: _sourceCwd,
  className
}: {
  src: string
  alt?: string
  sourceCwd?: string
  className?: string
}): JSX.Element {
  const t = useT()
  const notify = useStore((s) => s.notify)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const open = (): void => setViewerOpen(true)

  const transfer = async (kind: 'copy' | 'save'): Promise<void> => {
    const img = imageRef.current
    if (!img) return
    const dataUrl = (await pngDataUrl(img)) ?? (src.startsWith('data:') ? src : null)
    if (!dataUrl) {
      notify('error', t(kind === 'copy' ? 'chat.imageCopyFailed' : 'chat.imageSaveFailed'))
      return
    }
    if (kind === 'copy') {
      const result = await window.yan.copyImage(dataUrl).catch(() => ({ ok: false }))
      notify(result.ok ? 'info' : 'error', t(result.ok ? 'chat.imageCopied' : 'chat.imageCopyFailed'))
      return
    }
    const result = await window.yan
      .saveImage(dataUrl, imageName(src, alt))
      .catch(() => ({ ok: false, canceled: false }))
    if (result.canceled) return
    notify(result.ok ? 'info' : 'error', t(result.ok ? 'chat.imageSaved' : 'chat.imageSaveFailed'))
  }

  const menuItems = (): MessageMenuItem[] => [
    { id: 'copy-image', label: t('chat.copyImage'), run: () => void transfer('copy') },
    { id: 'save-image', label: t('chat.saveImage'), run: () => void transfer('save') }
  ]

  const onContextMenu = (event: ReactMouseEvent): void => {
    openMessageMenu(event, t('chat.imageActions'), menuItems())
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const img = imageRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    event.preventDefault()
    event.stopPropagation()
    openMessageMenu(
      { clientX: rect.left, clientY: rect.bottom, preventDefault: () => undefined, stopPropagation: () => undefined },
      t('chat.imageActions'),
      menuItems()
    )
  }

  return (
    <>
      <img
        ref={imageRef}
        src={src}
        alt={alt || t('chat.imageOpen')}
        className={[className, 'v3-img-open'].filter(Boolean).join(' ') || undefined}
        loading="lazy"
        decoding="async"
        title={t('chat.imageOpen')}
        onClick={open}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
      />
      <ImageViewer isOpen={viewerOpen} src={src} alt={alt} onOpenChange={setViewerOpen} />
    </>
  )
}
