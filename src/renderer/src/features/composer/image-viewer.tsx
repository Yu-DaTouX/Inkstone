import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react'
import { BareButton, Button, Dialog, IconButton, Modal, ModalOverlay } from '../../ui'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from '../../ui/icons'
import { useT } from '../../i18n'
import { InlineImage } from '../../ui/InlineImage'
import { ImageWipe } from '../../ui/ImageWipe'
import './image-viewer.css'

export interface ViewerImage {
  src: string
  alt?: string
  caption?: string
  before?: string
}

type Drag = { id: number; x: number; y: number; left: number; top: number }
type ZoomAnchor = { x: number; y: number; u: number; v: number }

function ImageViewport({ image, zoom, viewport }: { image: ViewerImage; zoom: number; viewport: RefObject<HTMLDivElement | null> }): JSX.Element {
  const t = useT()
  const [ratio, setRatio] = useState(1)
  const drag = useRef<Drag | null>(null)
  return (
    <div
      ref={viewport}
      className="imgv-viewport"
      data-zoomed={zoom > 1 || undefined}
      data-testid="image-viewer-viewport"
      tabIndex={zoom > 1 ? 0 : undefined}
      role={zoom > 1 ? 'region' : undefined}
      aria-label={zoom > 1 ? t('chat.imagePreview') : undefined}
      onPointerDown={(event) => {
        if (zoom <= 1 || event.button !== 0 || event.pointerType === 'touch') return
        const element = event.currentTarget
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
        element.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (start?.id !== event.pointerId) return
        event.currentTarget.scrollLeft = start.left + start.x - event.clientX
        event.currentTarget.scrollTop = start.top + start.y - event.clientY
      }}
      onLostPointerCapture={() => { drag.current = null }}
      style={{ '--imgv-zoom': zoom, '--imgv-ratio': ratio } as CSSProperties}
    >
      <div className="imgv-canvas">
        <InlineImage className="imgv-image" src={image.src} alt={image.alt ?? ''} draggable={false} onLoad={({ currentTarget }) => {
          if (currentTarget.naturalWidth && currentTarget.naturalHeight) setRatio(currentTarget.naturalWidth / currentTarget.naturalHeight)
        }} />
      </div>
    </div>
  )
}

export function ImageViewer({ src, alt, caption, before, isOpen, onOpenChange, gallery }: {
  src: string | null
  alt?: string
  caption?: string
  before?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  gallery?: readonly ViewerImage[]
}): JSX.Element | null {
  if (!isOpen || !src) return null
  return <OpenImageViewer key={src} initial={{ src, alt, caption, before }} gallery={gallery} onOpenChange={onOpenChange} />
}

function OpenImageViewer({ initial, gallery, onOpenChange }: {
  initial: ViewerImage
  gallery?: readonly ViewerImage[]
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const t = useT()
  const [index, setIndex] = useState(() => Math.max(0, gallery?.findIndex((image) => image.src === initial.src) ?? 0))
  const count = gallery?.length ?? 0
  const current = gallery?.[index] ?? initial
  const name = current.alt || t('chat.imagePreview')
  const [zoom, setZoom] = useState(1)
  const [compare, setCompare] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<ZoomAnchor | null>(null)
  const wheel = useRef({ at: 0, by: 0 })
  const press = useRef<{ x: number; y: number } | null>(null)
  const changeZoom = (by: number, pointer?: { clientX: number; clientY: number }): void => {
    if (!by || (zoom === 1 && by < 0) || (zoom === 4 && by > 0)) return
    const view = viewport.current
    const rect = view?.querySelector('img')?.getBoundingClientRect()
    if (view && rect?.width && rect.height) {
      const bounds = view.getBoundingClientRect()
      const x = pointer?.clientX ?? (bounds.left + bounds.width / 2)
      const y = pointer?.clientY ?? (bounds.top + bounds.height / 2)
      const u = Math.min(1, Math.max(0, (x - rect.left) / rect.width))
      const v = Math.min(1, Math.max(0, (y - rect.top) / rect.height))
      zoomAnchor.current = { x, y, u, v }
    }
    setZoom((value) => Math.min(4, Math.max(1, value + by)))
  }
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    zoomAnchor.current = null
    const view = viewport.current
    const rect = view?.querySelector('img')?.getBoundingClientRect()
    if (!view || !rect || !anchor) return
    view.scrollLeft += rect.left + anchor.u * rect.width - anchor.x
    view.scrollTop += rect.top + anchor.v * rect.height - anchor.y
  }, [zoom])
  const step = (by: number): void => {
    const next = index + by
    if (next < 0 || next >= count) return
    body.current?.focus({ preventScroll: true })
    zoomAnchor.current = null
    setZoom(1)
    setCompare(false)
    setIndex(next)
  }
  const onWheel = useEffectEvent((event: WheelEvent): void => {
    event.preventDefault()
    const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    const delta = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (body.current?.clientHeight ?? 0) : 1)
    if (event.ctrlKey) {
      if (!compare) changeZoom(-delta / 240, event)
      return
    }
    if (count < 2 || !delta) return
    const by = Math.sign(delta)
    const now = performance.now()
    if (by === wheel.current.by && now - wheel.current.at < 180) return
    wheel.current = { at: now, by }
    step(by)
  })
  useEffect(() => {
    const node = overlay.current
    const handle = (event: WheelEvent): void => onWheel(event)
    node?.addEventListener('wheel', handle, { passive: false })
    return () => node?.removeEventListener('wheel', handle)
  }, [])
  return (
    <ModalOverlay ref={overlay} className="imgv-overlay" isOpen onOpenChange={onOpenChange} isDismissable>
      <Modal className="imgv-modal">
        <Dialog className="imgv-dialog" aria-label={name} showClose={false} body="flush" padding="none">
          <div ref={body} tabIndex={-1} className="imgv-body" data-testid="image-viewer" onPointerDown={(event) => {
            press.current = { x: event.clientX, y: event.clientY }
          }} onClick={(event) => {
            const start = press.current
            press.current = null
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return
            if ((event.target as HTMLElement).closest('img, button, [role="button"], .imgv-tools, .imgv-label, .ui-image-wipe')) return
            onOpenChange(false)
          }} onKeyDown={(event) => {
            if (count < 2 || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
            if ((event.target as HTMLElement).closest('input, [data-zoomed]')) return
            event.preventDefault()
            step(event.key === 'ArrowLeft' ? -1 : 1)
          }}>
            <div className="imgv-head">
              <div className="imgv-label" title={name}>
                <span>{name}</span>
                {current.caption && current.caption !== current.alt ? <small title={current.caption}>{current.caption}</small> : null}
              </div>
            </div>
            <div className="imgv-stage" data-gallery={count > 1 || undefined}>
              {count > 1 ? (
                <BareButton className="imgv-edge" aria-label={t('chat.imagePrevious')} isDisabled={index === 0} data-testid="image-viewer-previous" onPress={() => step(-1)}>
                  <span className="ui-float imgv-edge-icon"><ChevronLeft size={24} aria-hidden="true" /></span>
                </BareButton>
              ) : null}
              {compare && current.before ? (
                <ImageWipe frameless before={current.before} after={current.src} beforeLabel={t('artifact.imageBefore')} afterLabel={t('artifact.imageAfter')} label={t('artifact.imageDivider')} />
              ) : <ImageViewport key={index} image={current} zoom={zoom} viewport={viewport} />}
              {count > 1 ? (
                <BareButton className="imgv-edge" aria-label={t('chat.imageNext')} isDisabled={index >= count - 1} data-testid="image-viewer-next" onPress={() => step(1)}>
                  <span className="ui-float imgv-edge-icon"><ChevronRight size={24} aria-hidden="true" /></span>
                </BareButton>
              ) : null}
            </div>
            <div className="imgv-dock">
              {!compare ? (
                <div className="ui-float imgv-tools">
                  <IconButton size="sm" aria-label={t('chat.imageZoomOut')} isDisabled={zoom <= 1} onPress={() => changeZoom(-0.5)}><ZoomOut size={16} /></IconButton>
                  <Button size="sm" variant="ghost" aria-label={t('chat.imageZoomReset')} isDisabled={zoom === 1} onPress={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
                  <IconButton size="sm" aria-label={t('chat.imageZoomIn')} isDisabled={zoom >= 4} data-testid="image-viewer-zoom-in" onPress={() => changeZoom(0.5)}><ZoomIn size={16} /></IconButton>
                </div>
              ) : null}
              {count > 1 ? <span className="ui-float ui-meta-num imgv-index" aria-live="polite" data-testid="image-viewer-index">{index + 1} / {count}</span> : null}
              {current.before ? <Button size="sm" variant={compare ? 'secondary' : 'glass'} aria-pressed={compare} data-testid="image-viewer-compare" onPress={() => setCompare((value) => !value)}>{t('artifact.imageCompare')}</Button> : null}
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
