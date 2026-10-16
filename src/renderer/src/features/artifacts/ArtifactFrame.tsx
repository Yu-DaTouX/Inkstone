/**
 * 成果框架（WP-32）：把受控 HTML 成果 / `yan-widget` 放进**同一个 iframe 实例**，
 * 切换内联 / 面板 / 全屏 / 画中画只改样式与容器，不重新加载、不丢页面内状态。
 *
 * 安全边界（与设计规范 §3.5.1、§11.6 一致，未放宽 CSP）：
 *   · `src` 只接受现有 `inkstone-html:` 协议地址；http(s)、file、data 一律拒绝；
 *   · 沿用主进程下发的 `sandbox` 与 CSP，本组件不碰 `allow` / `srcDoc`；
 *   · 桥只在 `bridge=true` 时启用，消息必须来自同一个 iframe 且实例代号一致，
 *     再经 `decodeBridgeMessage` 白名单校验、限速、限体积；
 *   · 这是 `yan-widget` 桥的安全子集，**不是** MCP Apps 宿主。
 *
 * 宿主形态（02 §11.2、§12.6）：
 *   · 内联：高度随内容，超过 min(70vh,720) 时底部渐隐并给「展开全屏」；
 *   · 全屏：`position: fixed` 覆盖对话区（侧栏与输入框保留），Esc 退出并归还焦点；
 *   · 画中画：固定在窗口坐标，可拖动移动、可拖右下角缩放，始终夹在视口内；
 *   · 形态切换只改根节点的 class / style，iframe 节点不动（key 只含身份与主动重载）。
 *
 * 生命周期：进入视口才装载；离开视口先冻结（保留高度占位）再卸载；
 * 同时活跃的框架最多 `MAX_ACTIVE_FRAMES` 个，超出时先冻结离屏、最久未见的一个。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react'
import { Maximize2, Minimize2, MoveDiagonal2, PictureInPicture2, RefreshCw, X } from 'lucide-react'
import { useT, type MessageKey } from '../../i18n'
import { Button, IconButton } from '../../ui'
import { HTML_ARTIFACT_SCHEME } from '../../../../shared/html-artifact-preview'
import {
  BridgeRateLimiter,
  MAX_ACTIVE_FRAMES,
  clampFramePosition,
  clampInlineHeight,
  decodeBridgeMessage,
  defaultPipRect,
  identityKey,
  inlineOverflows,
  moveFrame,
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

/* ── 活跃框架登记表 ───────────────────────────────────────────── */

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

/** 只接受砚自己的受控预览协议。 */
export function isTrustedArtifactUrl(src: string): boolean {
  return src.startsWith(`${HTML_ARTIFACT_SCHEME}://`) && /^inkstone-html:\/\/[a-f0-9]{32}\/index\.html$/.test(src)
}

function windowViewport(): FrameSize {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 对话区（消息流）的窗口坐标；全屏贴在它上面，下面的输入框与侧栏保持可见。 */
interface ConversationRect {
  top: number
  left: number
  width: number
  height: number
}

/* ── 组件 ─────────────────────────────────────────────────────── */

export interface ArtifactFrameProps {
  identity: ArtifactIdentity
  title: string
  /** 受控地址（`inkstone-html://…`）。其它协议显示明确的安全拒绝。 */
  src: string
  /** 缺省内联。切换形态由父级状态驱动，iframe 不重建。 */
  form?: ArtifactForm
  /** 主进程下发的 sandbox 字符串；不在本组件里放宽。 */
  sandbox: string
  /** 是否启用 `yan-widget` 桥（普通 HTML 成果没有桥）。 */
  bridge?: boolean
  /** 当前 iframe 实例代号；页面消息必须带同一个值。 */
  bridgeGeneration?: number
  /** 页面回报高度时的上限（内联形态用）。 */
  viewportHeight?: number
  /**
   * 外部已算好的「靠近视口」信号（调用方与快照申请共用同一个观察）。
   * 传入时本组件不再自己起 IntersectionObserver；缺省时保持原有自观察行为。
   */
  near?: boolean
  className?: string
  onDisplayModeRequest?: (form: ArtifactForm) => void
  onMessage?: (text: string) => void
  onOpenLink?: (url: string) => void
  onStateSave?: (text: string) => void
  /** iframe 每次装载完成时回调，便于调用方下发主题/恢复状态；不改变实例身份。 */
  onFrameReady?: (frame: HTMLIFrameElement) => void
  /** 关闭当前形态；缺省时退回内联。用于调用方想把收起动作并进自己的状态机。 */
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
  /** 进入全屏/画中画前的焦点元素；退出时归还。 */
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [observedNear, setObservedNear] = useState(false)
  const [height, setHeight] = useState(160)
  /** 页面回报的自然高度；用来判断内联是否溢出（未回报时为空，不假装溢出）。 */
  const [rawHeight, setRawHeight] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const [bridgeError, setBridgeError] = useState<BridgeError | null>(null)
  const [pipRect, setPipRect] = useState<FrameRect | null>(null)
  const [convRect, setConvRect] = useState<ConversationRect | null>(null)
  const trusted = isTrustedArtifactUrl(src)
  const near = nearProp ?? observedNear

  const admitted = useFrameAdmitted(key, near && trusted)
  const live = near && trusted && admitted

  /** 记录触发点，再交给父级切换形态；退出时把焦点还回去。 */
  const requestForm = useCallback(
    (next: ArtifactForm): void => {
      const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
      if ((next === 'fullscreen' || next === 'pip') && active && active !== document.body) returnFocusRef.current = active
      /* 画中画的位置先备好，避免进入时先闪一下未定位状态。 */
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
      /* 触发控件在形态切换中可能已卸载；退回到框架本身，不把焦点丢给 body。 */
      if (target && target.isConnected) target.focus?.()
      else rootRef.current?.focus?.()
    }, 0)
  }, [onClose, onDisplayModeRequest])

  /* 离视口先冻结、再卸载：两道边界不同，避免在边缘来回装载。
     调用方已经传入 near 时不再重复观察。 */
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

  /* 形态变化只改类名；实例 key 不含 form，因此 React 复用同一个 iframe DOM。
     只有用户主动「重新载入」才递增 `reload`，那是有意的重装载。 */
  const frameKey = `${key}#${reload}`

  /* 桥：只接受同一 iframe、同一实例代号的消息。 */
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
          /* 原始高度用于溢出判断；显示高度再按内联上限钳制。 */
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

  /* 全屏时 Esc 退出（气泡阶段：让模态先处理自己的 Esc，再轮到框架）。 */
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

  /* 全屏贴在对话区（消息流）：下面的输入框与左侧栏保持可见。 */
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

  /* 画中画：首次进入时给一个右下角默认位置，之后保持；窗口变化时夹回视口。 */
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

  /* 非内联形态把原内联高度留成占位，关闭全屏/画中画后滚动位置基本不变。 */
  const anchorHeight = form === 'inline' || form === 'panel' ? 0 : clampInlineHeight(height, viewportHeight)

  if (!trusted) {
    return (
      <div
        className={`v3-artifact-frame v3-artifact-frame--invalid ${className ?? ''}`}
        data-testid="v3-artifact-frame"
        data-frame-key={key}
        data-form={form}
        role="alert"
      >
        <span>{t('artifact.htmlOutside')}</span>
      </div>
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
            /* 关键：key 只含身份，不含 form；切形态不会重建页面 */
            key={frameKey}
            className="v3-artifact-frame-view"
            src={src}
            title={title}
            sandbox={sandbox}
            /* 内联溢出时让页面按自然高度展开、由外层裁剪，避免内联出现嵌套滚动条。 */
            style={form === 'inline' && inlineOverflow && rawHeight ? { height: rawHeight, flex: 'none' } : undefined}
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; display-capture 'none'; usb 'none'; serial 'none'; payment 'none'"
            data-testid="v3-artifact-frame-iframe"
            data-generation={bridge ? String(bridgeGeneration) : undefined}
            onLoad={() => {
              /* 新实例重新计时，避免上一帧的节流窗口影响刚载入的页面。 */
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
          <div className="v3-artifact-frame-error" role="alert" data-testid="v3-artifact-frame-bridge-error">
            {t(ERROR_KEYS[bridgeError])}
          </div>
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
            aria-label={at('resizeHint')}
            title={at('resizeHint')}
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
