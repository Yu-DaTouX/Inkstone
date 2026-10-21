import { useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { openMessageMenu, type MessageMenuItem } from './message-menu'
import { ImageViewer } from '../composer/image-viewer'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

const DATA_IMAGE = /^data:image\/([a-z0-9.+-]+);base64,/i

export function imageFileSrc(src: string): string | null {
  if (!/^file:\/\//i.test(src)) return null
  let rest = src.slice('file://'.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  let path: string
  try {
    path = decodeURIComponent(rest)
  } catch {
    return null
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) return path.slice(1)
  if (!path.startsWith('/')) return `//${path}`
  return path
}

export function imageMimeFromPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null
}

export function imageDataMime(src: string): string | null {
  const head = DATA_IMAGE.exec(src)
  if (!head) return null
  return IMAGE_MIME[head[1].toLowerCase()] ?? null
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  }
  return btoa(binary)
}

const CLIPBOARD_IMAGE_MIME = new Set(['image/png'])

export async function imageTransferDataUrl(
  src: string,
  sourceCwd: string | undefined,
  target: 'copy' | 'save',
  readBytes: (path: string, cwd?: string) => Promise<{ ok: boolean; bytes?: Uint8Array }>,
  render: () => Promise<string | null>,
  convert?: (bytes: Uint8Array, mime: string) => Promise<string | null>
): Promise<string | null> {
  const passthrough = (mime: string): boolean => target === 'save' || CLIPBOARD_IMAGE_MIME.has(mime)
  const inlineMime = imageDataMime(src)
  if (inlineMime && passthrough(inlineMime)) return src
  const path = imageFileSrc(src)
  const mime = path ? imageMimeFromPath(path) : null
  if (path && mime) {
    const file = await readBytes(path, sourceCwd).catch(() => null)
    if (file?.ok && file.bytes?.length) {
      if (passthrough(mime)) return `data:${mime};base64,${base64OfBytes(file.bytes)}`
      const converted = convert ? await convert(file.bytes, mime).catch(() => null) : null
      if (converted) return converted
    }
  }
  return render()
}

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

async function pngDataUrlFromBytes(bytes: Uint8Array, mime: string): Promise<string | null> {
  const img = new Image()
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
  })
  img.src = `data:${mime};base64,${base64OfBytes(bytes)}`
  return (await loaded) ? await pngDataUrl(img) : null
}

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
  const notify = useStore((s) => s.notify)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const open = (): void => setViewerOpen(true)

  const transfer = async (kind: 'copy' | 'save'): Promise<void> => {
    const dataUrl = await imageTransferDataUrl(
      src,
      sourceCwd,
      kind,
      (path, cwd) => window.yan.readPreviewBytes(path, cwd),
      async () => {
        const img = imageRef.current
        return img ? pngDataUrl(img) : null
      },
      kind === 'copy' ? pngDataUrlFromBytes : undefined
    )
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
      .saveImage(dataUrl, imageName(imageFileSrc(src) ?? src, alt))
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
