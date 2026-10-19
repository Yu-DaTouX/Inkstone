import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react'
import { Maximize2, Minimize2, MoveDiagonal2, PictureInPicture2, RefreshCw, X } from 'lucide-react'
import { useT, type MessageKey } from '../../i18n'
import { Button, IconButton, Notice } from '../../ui'
import { HTML_ARTIFACT_SCHEME } from '../../../../shared/html-artifact-preview'
import {
  BridgeRateLimiter,
  MAX_ACTIVE_FRAMES,
  PIP_SIZE,
  clampFramePosition,
  clampInlineHeight,
  decodeBridgeMessage,
  defaultPipRect,
  identityKey,
  inlineOverflows,
  moveFrame,
  nudgeFrame,
  resizeFrame,
  selectFrameEvictions,
  type ArtifactForm,
  type ArtifactIdentity,
  type BridgeAction,
  type BridgeError,
  type FrameRect,
  type FrameSize
} from './model'
import { useArtifactText } from './text'
import './artifacts.css'

interface FrameRecord {
  key: string
  visible: boolean
  lastSeenAt: number
}

const frameRecords = new Map<string, FrameRecord>()
const frameListeners = new Set<() => void>()
let frameSnapshot: readonly string[] = []

function publishFrames(): void {
  const active = [...frameRecords.values()].filter((record) => record.visible)
  const evicted = new Set(selectFrameEvictions(active, MAX_ACTIVE_FRAMES))
  frameSnapshot = active.filter((record) => !evicted.has(record.key)).map((record) => record.key)
  frameListeners.forEach((listener) => listener())
}

function touchFrame(key: string, visible: boolean): void {
  const existing = frameRecords.get(key)
  if (!existing && !visible) return
  frameRecords.set(key, { key, visible, lastSeenAt: visible ? Date.now() : existing?.lastSeenAt ?? 0 })
  publishFrames()
}

function dropFrame(key: string): void {
  if (!frameRecords.delete(key)) return
  publishFrames()
}

function useFrameAdmitted(key: string, visible: boolean): boolean {
  const admitted = useSyncExternalStore(
    (listener) => {
      frameListeners.add(listener)
      return () => frameListeners.delete(listener)
    },
    () => frameSnapshot.includes(key)
  )
  useEffect(() => {
    touchFrame(key, visible)
    return () => dropFrame(key)
  }, [key, visible])
  return admitted
}

export function isTrustedArtifactUrl(src: string): boolean {
  return src.startsWith(`${HTML_ARTIFACT_SCHEME}://`) && /^inkstone-html:\/\/[a-f0-9]{32}\/index\.html$/.test(src)
}

function windowViewport(): FrameSize {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}

interface ConversationRect {
  top: number
  left: number
  width: number
  height: number
}

export interface ArtifactFrameProps {
  identity: ArtifactIdentity
  title: string
  src: string
  form?: ArtifactForm
  sandbox: string
  bridge?: boolean
  bridgeGeneration?: number
  viewportHeight?: number
  near?: boolean
  className?: string
  onDisplayModeRequest?: (form: ArtifactForm) => void
  onMessage?: (text: string) => void
  onOpenLink?: (url: string) => void
  onStateSave?: (text: string) => void
  onFrameReady?: (frame: HTMLIFrameElement) => void
  onClose?: () => void
}

const ERROR_KEYS: Record<BridgeError, MessageKey> = {
  source: 'artifact.htmlRead',
  generation: 'artifact.htmlRead',
  shape: 'artifact.htmlRead',
  size: 'artifact.htmlSize',
  limit: 'artifact.htmlSize',
  unsupported: 'artifact.htmlBusy',
  url: 'artifact.htmlOutside'
}

export function ArtifactFrame({
  identity,
  title,
  src,
  form = 'inline',
  sandbox,
  bridge = false,
  bridgeGeneration = 0,
  viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight,
  near: nearProp,
  className,
  onDisplayModeRequest,
  onMessage,
  onOpenLink,
  onStateSave,
  onFrameReady,
  onClose
}: ArtifactFrameProps): JSX.Element {
  const t = useT()
  const at = useArtifactText()
  const key = identityKey(identity)
  const rootRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const limiter = useRef(new BridgeRateLimiter())
  const interactionRef = useRef<{ mode: 'drag' | 'resize'; pointerId: number; startX: number; startY: number; origin: FrameRect } | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [observedNear, setObservedNear] = useState(false)
  const [height, setHeight] = useState(160)
  const [rawHeight, setRawHeight] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const [bridgeError, setBridgeError] = useState<BridgeError | null>(null)
  const [pipRect, setPipRect] = useState<FrameRect | null>(null)
  const [convRect, setConvRect] = useState<ConversationRect | null>(null)
  const trusted = isTrustedArtifactUrl(src)
  const near = nearProp ?? observedNear

  const admitted = useFrameAdmitted(key, near && trusted)
  const live = near && trusted && admitted

  const requestForm = useCallback(
    (next: ArtifactForm): void => {
      const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
      if ((next === 'fullscreen' || next === 'pip') && active && active !== document.body) returnFocusRef.current = active
      if (next === 'pip') setPipRect((current) => current ?? defaultPipRect(windowViewport()))
      onDisplayModeRequest?.(next)
    },
    [onDisplayModeRequest]
  )

  const exitToInline = useCallback((): void => {
    if (onClose) onClose()
    else if (onDisplayModeRequest) onDisplayModeRequest('inline')
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      if (target && target.isConnected) target.focus?.()
      else rootRef.current?.focus?.()
    }, 0)
  }, [onClose, onDisplayModeRequest])

  useEffect(() => {
    if (nearProp !== undefined) return undefined
    const node = rootRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setObservedNear(true)
      return undefined
    }
    const load = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setObservedNear(true)
      },
      { rootMargin: '240px' }
    )
    const keep = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) setObservedNear(false)
      },
      { rootMargin: '1200px' }
    )
    load.observe(node)
    keep.observe(node)
    return () => {
      load.disconnect()
      keep.disconnect()
    }
  }, [nearProp])

  const frameKey = `${key}#${reload}`

  useEffect(() => {
    if (!bridge || !live) return undefined
    const onMessageEvent = (event: MessageEvent): void => {
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (!limiter.current.allow(Date.now())) return
      const decoded = decodeBridgeMessage(event.data, { sourceOk: true, frameGeneration: bridgeGeneration })
      if (!decoded.ok) {
        setBridgeError(decoded.error)
        return
      }
      setBridgeError(null)
      applyBridgeAction(decoded.action)
    }
    const applyBridgeAction = (action: BridgeAction): void => {
      switch (action.kind) {
        case 'ready':
          break
        case 'size-changed':
          setRawHeight((current) => (current === null || Math.abs(current - action.height) > 1 ? action.height : current))
          setHeight(clampInlineHeight(action.height, viewportHeight))
          break
        case 'request-display-mode':
          requestForm(action.form)
          break
        case 'message':
          onMessage?.(action.text)
          break
        case 'open-link':
          onOpenLink?.(action.url)
          break
        case 'update-model-context':
          onMessage?.(action.text)
          break
        case 'state-save':
          onStateSave?.(action.text)
          break
        case 'state-restore':
          break
      }
    }
    window.addEventListener('message', onMessageEvent)
    return () => window.removeEventListener('message', onMessageEvent)
  }, [bridge, live, bridgeGeneration, viewportHeight, onMessage, onOpenLink, onStateSave, requestForm])

  useEffect(() => {
    if (form !== 'fullscreen') return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      exitToInline()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [form, exitToInline])

  useEffect(() => {
    if (form !== 'fullscreen') return undefined
    const node = (rootRef.current?.closest?.('.v3-conv') as HTMLElement | null) ?? null
    if (!node) return undefined
    const update = (): void => {
      const rect = node.getBoundingClientRect()
      setConvRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [form])

  useEffect(() => {
    if (form !== 'pip') return undefined
    setPipRect((current) => current ?? defaultPipRect(windowViewport()))
    const onResize = (): void => setPipRect((current) => (current ? clampFramePosition(current, windowViewport()) : current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [form])

  const beginInteraction = (mode: 'drag' | 'resize') => (event: React.PointerEvent<HTMLElement>): void => {
    if (form !== 'pip' || !pipRect) return
    if (mode === 'drag' && (event.target as HTMLElement).closest('button, a, input, [role="button"]')) return
    event.preventDefault()
    event.stopPropagation()
    interactionRef.current = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: pipRect }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onInteractionMove = (event: React.PointerEvent<HTMLElement>): void => {
    const interaction = interactionRef.current
    if (!interaction) return
    const dx = event.clientX - interaction.startX
    const dy = event.clientY - interaction.startY
    const viewport = windowViewport()
    setPipRect(
      interaction.mode === 'drag'
        ? moveFrame(interaction.origin, dx, dy, viewport)
        : resizeFrame(interaction.origin, dx, dy, viewport)
    )
  }

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (form !== 'pip' || !pipRect) return
    const next = nudgeFrame(pipRect, event.key, { alt: event.altKey, shift: event.shiftKey }, windowViewport())
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    setPipRect(next)
  }

  const endInteraction = (event: React.PointerEvent<HTMLElement>): void => {
    if (interactionRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      interactionRef.current = null
    }
  }

  const inlineOverflow = form === 'inline' && rawHeight !== null && inlineOverflows(rawHeight, viewportHeight)

  let style: CSSProperties
  if (form === 'inline') {
    style = { height: clampInlineHeight(height, viewportHeight) }
  } else if (form === 'fullscreen') {
    style = convRect ? { top: convRect.top, left: convRect.left, width: convRect.width, height: convRect.height } : {}
  } else if (form === 'pip') {
    style = pipRect ? { top: pipRect.y, left: pipRect.x, width: pipRect.width, height: pipRect.height } : {}
  } else {
    style = { height: '100%' }
  }

  const anchorHeight = form === 'inline' || form === 'panel' ? 0 : clampInlineHeight(height, viewportHeight)

  if (!trusted) {
    return (
      <Notice
        tone="fail"
        className={`v3-artifact-frame--invalid ${className ?? ''}`}
        data-testid="v3-artifact-frame"
        data-frame-key={key}
        data-form={form}
      >
        {t('artifact.htmlOutside')}
      </Notice>
    )
  }

  return (
    <>
      <div className="v3-artifact-frame-anchor" style={anchorHeight ? { height: anchorHeight } : undefined} aria-hidden />
      <div
        ref={rootRef}
        className={`v3-artifact-frame v3-artifact-frame--${form} ${className ?? ''}`}
        data-testid="v3-artifact-frame"
        data-frame-key={key}
        data-form={form}
        data-live={live ? '1' : undefined}
        data-overflow={inlineOverflow ? '1' : undefined}
        tabIndex={-1}
        style={style}
        onClick={(event) => event.stopPropagation()}
      >
        {form !== 'inline' ? (
          <div
            className="v3-artifact-frame-head"
            data-testid="v3-artifact-frame-head"
            onPointerDown={beginInteraction('drag')}
            onPointerMove={onInteractionMove}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
          >
            <span className="v3-artifact-frame-title" title={title}>
              {title}
            </span>
            <div className="v3-artifact-frame-actions">
              {form !== 'fullscreen' ? (
                <IconButton
                  aria-label={at('fullscreen')}
                  title={at('fullscreen')}
                  data-testid="v3-artifact-frame-fullscreen"
                  onPress={() => requestForm('fullscreen')}
                >
                  <Maximize2 size={14} />
                </IconButton>
              ) : null}
              {form !== 'pip' ? (
                <IconButton
                  aria-label={at('pip')}
                  title={at('pip')}
                  data-testid="v3-artifact-frame-pip"
                  onPress={() => requestForm('pip')}
                >
                  <PictureInPicture2 size={14} />
                </IconButton>
              ) : null}
              <IconButton
                aria-label={t('artifact.htmlReload')}
                title={t('artifact.htmlReload')}
                data-testid="v3-artifact-frame-reload"
                onPress={() => setReload((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </IconButton>
              <IconButton
                aria-label={form === 'pip' ? at('exitPip') : at('exitFullscreen')}
                title={form === 'pip' ? at('exitPip') : at('exitFullscreen')}
                data-testid="v3-artifact-frame-close"
                onPress={exitToInline}
              >
                {form === 'pip' ? <X size={14} /> : <Minimize2 size={14} />}
              </IconButton>
            </div>
          </div>
        ) : (
          <div className="v3-artifact-frame-tools" data-testid="v3-artifact-frame-tools">
            <IconButton
              aria-label={at('fullscreen')}
              title={at('fullscreen')}
              data-testid="v3-artifact-frame-expand"
              onPress={() => requestForm('fullscreen')}
            >
              <Maximize2 size={14} />
            </IconButton>
            <IconButton
              aria-label={at('pip')}
              title={at('pip')}
              data-testid="v3-artifact-frame-pip"
              onPress={() => requestForm('pip')}
            >
              <PictureInPicture2 size={14} />
            </IconButton>
          </div>
        )}
        {live ? (
          <iframe
            ref={iframeRef}
            key={frameKey}
            className="v3-artifact-frame-view"
            src={src}
            title={title}
            sandbox={sandbox}
            style={form === 'inline' && inlineOverflow && rawHeight ? { height: rawHeight, flex: 'none' } : undefined}
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"
            data-testid="v3-artifact-frame-iframe"
            data-generation={bridge ? String(bridgeGeneration) : undefined}
            onLoad={() => {
              limiter.current.reset()
              if (iframeRef.current) onFrameReady?.(iframeRef.current)
            }}
          />
        ) : (
          <div className="v3-artifact-frame-parked" role="status" data-testid="v3-artifact-frame-parked">
            {t('artifact.htmlParked')}
          </div>
        )}
        {bridgeError ? (
          <Notice tone="fail" compact className="v3-artifact-frame-error" data-testid="v3-artifact-frame-bridge-error">
            {t(ERROR_KEYS[bridgeError])}
          </Notice>
        ) : null}
        {inlineOverflow ? (
          <div className="v3-artifact-frame-fade" data-testid="v3-artifact-frame-fade">
            <Button size="sm" variant="primary" data-testid="v3-artifact-frame-expand-cta" onPress={() => requestForm('fullscreen')}>
              {at('fullscreen')}
            </Button>
          </div>
        ) : null}
        {form === 'pip' ? (
          <div
            className="v3-artifact-frame-resize"
            data-testid="v3-artifact-frame-resize"
            role="separator"
            tabIndex={0}
            aria-label={at('resizeHint')}
            aria-valuenow={pipRect ? pipRect.width : undefined}
            aria-valuemin={PIP_SIZE.min.width}
            aria-valuemax={PIP_SIZE.max.width}
            title={at('resizeHint')}
            onKeyDown={onHandleKeyDown}
            onPointerDown={beginInteraction('resize')}
            onPointerMove={onInteractionMove}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
          >
            <MoveDiagonal2 size={14} />
          </div>
        ) : null}
      </div>
    </>
  )
}
