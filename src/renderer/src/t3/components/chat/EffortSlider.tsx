import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../../i18n'
import { FluidEffortSlider } from '../../../ui/FluidEffortSlider'
import { EFFORT_TITLE, effortHint, type ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cx } from '../../../ui/cx'
import { Tooltip, TooltipTrigger } from '../../../ui'
import { ComposerControl, type ComposerControlSize } from './ComposerControl'
import { composerFloatingLayerProps } from './composerEventScope'
import { useComposerMenuState } from './useComposerMenuState'
import './EffortSlider.css'

const WHEEL_STEP_INTERVAL_MS = 130
const WHEEL_STEP_DELTA = 4
const PANEL_HEIGHT = 136
const PANEL_WIDTH = 320

export function levelFallbackLabel(level: string): string {
  return level === 'xhigh' ? 'XHigh' : level.charAt(0).toUpperCase() + level.slice(1)
}

type Anchor = {
  centerY: number
  triggerLeft: number
  triggerWidth: number
  viewportHeight: number
  viewportWidth: number
}

const VIEWPORT_MARGIN = 8
const FLIP_DURATION_MS = 180

function readAnchor(trigger: HTMLElement): Anchor {
  const triggerRect = trigger.getBoundingClientRect()
  return {
    centerY: triggerRect.top + triggerRect.height / 2,
    triggerLeft: triggerRect.left,
    triggerWidth: triggerRect.width,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth
  }
}

function readEasing(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-glide').trim()
  return value || 'cubic-bezier(.22,1,.36,1)'
}

function EffortTextContent(props: { text: string }) {
  return (
    <>
      {props.text}
      <span className="composer-effort-sheen" aria-hidden="true">
        <span className="composer-effort-sheen-text">{props.text}</span>
      </span>
    </>
  )
}

export function EffortSlider(props: {
  traits: ComposerTraitsAdapter
  size: ComposerControlSize
  disabled: boolean
  hidden?: boolean
  className?: string
  onOpen?: () => void
  expanded?: boolean
}) {
  const t = useT()
  const { traits } = props
  const { descriptor } = traits
  const levels = traits.levels
  const count = levels.length
  const current = descriptor.currentValue
  const currentLevel = current ?? 'off'
  const rawIndex = current === null ? 0 : levels.indexOf(current)
  const index = rawIndex < 0 ? count - 1 : rawIndex
  const labelOf = (level: string) =>
    descriptor.options.find((option) => option.id === level)?.label ?? levelFallbackLabel(level)
  const currentLabel =
    descriptor.options.find((option) => option.id === current)?.label ?? descriptor.label
  const blocked = props.disabled || traits.unsupportedReason !== null
  const triggerLabel = traits.unsupportedShortLabel ?? currentLabel
  const sizerLabels = Array.from(new Set([...levels.map(labelOf), triggerLabel]))
  const tooltip = blocked
    ? (traits.unsupportedReason ?? `${descriptor.label}: ${currentLabel}`)
    : `${descriptor.label}: ${currentLabel}`

  const triggerRef = useRef<HTMLButtonElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const [columnNode, setColumnNode] = useState<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const previousRef = useRef({ text: triggerLabel, index, level: currentLevel })
  const ghostRef = useRef<HTMLSpanElement | null>(null)
  const flipRef = useRef<Animation | null>(null)
  const [open, setOpen] = useComposerMenuState(props.hidden || blocked)
  const slotRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const lockRef = useRef({ trigger: false, column: false, open: false, width: 0 })
  const widthLabelRef = useRef(triggerLabel)
  widthLabelRef.current = triggerLabel

  const stateRef = useRef({ index, blocked, count, levels, select: traits.select })
  stateRef.current = { index, blocked, count, levels, select: traits.select }

  const fitWidth = useCallback(() => {
    const slot = slotRef.current
    const measure = measureRef.current
    if (!slot || !measure) return
    const samples = Array.from(measure.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
    )
    const sample = samples.find((child) => child.dataset.label === widthLabelRef.current)
    const natural = sample?.getBoundingClientRect().width ?? 0
    if (natural <= 0) return
    const lock = lockRef.current
    const widest = Math.max(natural, ...samples.map((child) => child.getBoundingClientRect().width))
    lock.width = widest
    const bar = slot.closest('[data-resting-block]')?.parentElement
    bar?.style.setProperty('--effort-slack', `${widest - natural}px`)
    const next = natural
    const previous = parseFloat(slot.style.width) || slot.getBoundingClientRect().width
    if (Math.abs(next - previous) < 0.25) return
    delete slot.dataset.effortSettling
    slot.style.width = `${next}px`
    const trigger = triggerRef.current
    if (next > previous && lock.open && trigger) setAnchor(readAnchor(trigger))
  }, [])

  useLayoutEffect(() => {
    fitWidth()
  }, [triggerLabel, fitWidth])

  useLayoutEffect(() => {
    lockRef.current.open = open
    fitWidth()
  }, [open, fitWidth])

  useEffect(() => {
    const measure = measureRef.current
    if (!measure || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fitWidth())
    observer.observe(measure)
    return () => observer.disconnect()
  }, [fitWidth])

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const enter = () => {
      lockRef.current.trigger = true
      fitWidth()
    }
    const leave = () => {
      lockRef.current.trigger = false
      fitWidth()
    }
    trigger.addEventListener('pointerenter', enter)
    trigger.addEventListener('pointerleave', leave)
    return () => {
      trigger.removeEventListener('pointerenter', enter)
      trigger.removeEventListener('pointerleave', leave)
    }
  }, [fitWidth])

  useEffect(() => {
    if (!columnNode) return
    const enter = () => {
      lockRef.current.column = true
      fitWidth()
    }
    const leave = () => {
      lockRef.current.column = false
      fitWidth()
    }
    columnNode.addEventListener('pointerenter', enter)
    columnNode.addEventListener('pointerleave', leave)
    return () => {
      columnNode.removeEventListener('pointerenter', enter)
      columnNode.removeEventListener('pointerleave', leave)
      lockRef.current.column = false
    }
  }, [columnNode, fitWidth])

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    setAnchor(readAnchor(trigger))
  }, [open])

  useLayoutEffect(() => {
    const previous = previousRef.current
    previousRef.current = { text: triggerLabel, index, level: currentLevel }
    if (previous.text === triggerLabel) return
    const label = labelRef.current
    const slot = label?.parentElement
    if (!label || !slot) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const direction = index > previous.index ? -1 : 1
    const easing = readEasing()
    const computed = getComputedStyle(label)
    const inFlight = flipRef.current !== null
    const fromTransform =
      inFlight && computed.transform !== 'none' ? computed.transform : 'translateY(0)'
    const fromOpacity = inFlight ? computed.opacity : '1'
    flipRef.current?.cancel()
    flipRef.current = null
    ghostRef.current?.remove()
    const ghost = document.createElement('span')
    ghost.textContent = previous.text
    ghost.className = 'composer-effort-text'
    ghost.dataset.composerEffortGhost = 'true'
    ghost.dataset.effortLevel = previous.level
    ghost.setAttribute('aria-hidden', 'true')
    slot.appendChild(ghost)
    ghostRef.current = ghost
    const options = { duration: FLIP_DURATION_MS, easing, fill: 'both' as const }
    const dropGhost = () => {
      ghost.remove()
      if (ghostRef.current === ghost) ghostRef.current = null
    }
    ghost
      .animate(
        [
          { transform: fromTransform, opacity: fromOpacity },
          { transform: `translateY(${-direction * 100}%)`, opacity: 0 }
        ],
        options
      )
      .finished.then(dropGhost, dropGhost)
    const flip = label.animate(
      [
        { transform: `translateY(${direction * 100}%)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 }
      ],
      { duration: FLIP_DURATION_MS, easing }
    )
    flipRef.current = flip
    const release = () => {
      if (flipRef.current === flip) flipRef.current = null
    }
    flip.finished.then(release, release)
  }, [triggerLabel, index, currentLevel])

  useEffect(
    () => () => {
      flipRef.current?.cancel()
      ghostRef.current?.remove()
    },
    []
  )

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }

  const commit = (position: number) => {
    const state = stateRef.current
    if (state.blocked) return
    const next = Math.min(state.count - 1, Math.max(0, position))
    const level = state.levels[next]
    if (!level || level === state.levels[state.index]) return
    state.select(level)
  }

  useEffect(() => {
    let lastStepAt = 0
    const onWheel = (event: WheelEvent) => {
      const state = stateRef.current
      if (state.blocked) return
      if (Math.abs(event.deltaY) < WHEEL_STEP_DELTA) return
      event.preventDefault()
      const now = event.timeStamp || Date.now()
      if (now - lastStepAt < WHEEL_STEP_INTERVAL_MS) return
      lastStepAt = now
      const next = (state.index + (event.deltaY < 0 ? 1 : -1) + state.count) % state.count
      const level = state.levels[next]
      if (!level || level === state.levels[state.index]) return
      state.select(level)
    }
    const nodes: HTMLElement[] = []
    if (triggerRef.current) nodes.push(triggerRef.current)
    if (columnNode) nodes.push(columnNode)
    for (const node of nodes) node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      for (const node of nodes) node.removeEventListener('wheel', onWheel)
    }
  }, [columnNode])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (columnRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, setOpen])

  const columnReady = columnNode !== null
  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT)
  useEffect(() => {
    if (columnReady) columnRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [columnReady])
  useLayoutEffect(() => {
    if (columnNode && columnNode.offsetHeight > 0) setPanelHeight(columnNode.offsetHeight)
  }, [columnNode])

  const columnHeight = panelHeight
  const alignedTop = anchor ? anchor.centerY - columnHeight - VIEWPORT_MARGIN : 0
  const columnTop = anchor
    ? Math.max(
        VIEWPORT_MARGIN,
        Math.min(alignedTop, anchor.viewportHeight - VIEWPORT_MARGIN - columnHeight)
      )
    : 0
  const columnWidth = anchor ? Math.min(PANEL_WIDTH, anchor.viewportWidth - VIEWPORT_MARGIN * 2) : PANEL_WIDTH
  const columnLeft = anchor
    ? Math.max(
        VIEWPORT_MARGIN,
        Math.min(anchor.triggerLeft, anchor.viewportWidth - VIEWPORT_MARGIN - columnWidth)
      )
    : 0

  return (
    <>
      <TooltipTrigger delay={150}>
              <ComposerControl
                ref={triggerRef}
                aria-disabled={blocked || undefined}
                aria-label={tooltip}
                aria-haspopup="dialog"
                aria-expanded={props.onOpen ? !!props.expanded : open}
                data-composer-shortcut="composer.effort"
                data-composer-effort-trigger="true"
                data-effort-level={currentLevel}
                size={props.size}
                onPress={() => {
                  if (props.onOpen) {
                    props.onOpen()
                    return
                  }
                  if (blocked) return
                  setOpen(!open)
                }}
                className={cx(
                  'composer-effort-trigger t3-effort__trigger',
                  props.className,
                  blocked && 't3-effort__trigger--blocked'
                )}
              >
            <span ref={slotRef} className="composer-effort-slot" data-composer-effort-slot>
              <span ref={measureRef} className="composer-effort-measure" aria-hidden="true">
                {sizerLabels.map((text) => (
                  <span key={text} data-label={text}>
                    {text}
                  </span>
                ))}
              </span>
              <span ref={labelRef} className="composer-effort-text" data-composer-effort-label>
                <EffortTextContent text={triggerLabel} />
              </span>
            </span>
              </ComposerControl>
          {props.onOpen ? null : (
            <Tooltip placement="top">
              <span className="t3-effort__tip">
                <span>{tooltip}</span>
                {blocked ? null : (
                  <span className="t3-effort__tip-hint">{t('composer.t3.effort.wheel')}</span>
                )}
              </span>
            </Tooltip>
          )}
      </TooltipTrigger>
      {open && anchor
        ? createPortal(
            <div
              ref={(node) => {
                columnRef.current = node
                setColumnNode(node)
              }}
              role="dialog"
              tabIndex={0}
              aria-label={descriptor.label}
              data-composer-effort-panel="true"
              {...composerFloatingLayerProps}
              className="composer-effort-column ui-float t3-effort__panel"
              style={{
                top: columnTop,
                left: columnLeft,
                width: columnWidth
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' || (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement))) {
                  event.preventDefault()
                  event.stopPropagation()
                  close(true)
                  return
                }
              }}
            >
              <FluidEffortSlider
                label={descriptor.label}
                title={EFFORT_TITLE}
                describe={(level) => effortHint(t, level)}
                levels={levels}
                value={currentLevel}
                labelOf={labelOf}
                disabled={blocked}
                onChange={(level) => commit(levels.indexOf(level))}
              />
            </div>,
            document.body
          )
        : null}
    </>
  )
}
