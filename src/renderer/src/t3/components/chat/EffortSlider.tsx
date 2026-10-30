import { useEffect, useRef } from 'react'
import { useT } from '../../../i18n'
import type { ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { ComposerControl, type ComposerControlSize } from './ComposerControl'

const WHEEL_STEP_INTERVAL_MS = 130
const WHEEL_STEP_DELTA = 4

export function EffortSlider(props: {
  traits: ComposerTraitsAdapter
  size: ComposerControlSize
  disabled: boolean
  className?: string
  onOpenMenu: () => void
  anchorRef: { current: HTMLElement | null }
}) {
  const t = useT()
  const { traits, disabled } = props
  const levels = traits.levels
  const count = levels.length
  const current = traits.descriptor.currentValue
  const rawIndex = current === null ? 0 : levels.indexOf(current)
  const index = disabled || count <= 1 ? 0 : rawIndex < 0 ? count - 1 : rawIndex
  const filled = count <= 1 ? count : index + 1
  const currentLabel =
    (current !== null
      ? traits.descriptor.options.find((option) => option.id === current)?.label
      : null) ?? traits.descriptor.label
  const blocked = disabled || traits.unsupportedReason !== null

  const nodeRef = useRef<HTMLElement | null>(null)
  const stateRef = useRef({ index, blocked, select: traits.select })

  const commit = (next: number) => {
    if (blocked) return
    const level = levels[Math.min(count - 1, Math.max(0, next))]
    if (!level || level === current) return
    traits.select(level)
  }

  stateRef.current = { index, blocked, select: traits.select }

  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    let lastStepAt = 0
    const onWheel = (event: WheelEvent) => {
      if (stateRef.current.blocked) return
      if (Math.abs(event.deltaY) < WHEEL_STEP_DELTA) return
      event.preventDefault()
      const now = event.timeStamp || Date.now()
      if (now - lastStepAt < WHEEL_STEP_INTERVAL_MS) return
      lastStepAt = now
      const step = event.deltaY < 0 ? 1 : -1
      const next = stateRef.current.index + step
      const level = levels[Math.min(count - 1, Math.max(0, next))]
      if (!level || level === current) return
      stateRef.current.select(level)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [count, current, levels])

  const levelAtPointer = (event: { clientY: number; currentTarget: Element }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.height <= 0) return count - 1
    const ratio = (event.clientY - rect.top) / rect.height
    const position = Math.min(count - 1, Math.max(0, Math.floor(ratio * count)))
    return count - 1 - position
  }

  const tooltip = traits.unsupportedReason ?? `${traits.descriptor.label}: ${currentLabel}`

  return (
    <ComposerControl
      ref={(node) => {
        nodeRef.current = node as unknown as HTMLElement | null
        props.anchorRef.current = node as unknown as HTMLElement | null
      }}
      render={<span />}
      role="slider"
      tabIndex={0}
      aria-label={traits.descriptor.label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={index}
      aria-valuetext={tooltip}
      aria-disabled={blocked || undefined}
      data-composer-effort-slider="true"
      size={props.size}
      className={cn(
        'shrink-0 px-1',
        blocked
          ? 'cursor-default text-muted-foreground/60 hover:bg-transparent'
          : 'text-muted-foreground hover:text-foreground',
        props.className
      )}
      onPointerDown={(event) => {
        event.currentTarget.focus()
        if (blocked) return
        event.currentTarget.setPointerCapture(event.pointerId)
        commit(levelAtPointer(event))
      }}
      onPointerMove={(event) => {
        if (blocked || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        commit(levelAtPointer(event))
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onOpenMenu()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'F10' || event.key === 'ContextMenu') {
          event.preventDefault()
          props.onOpenMenu()
          return
        }
        if (blocked) return
        const step =
          event.key === 'ArrowUp' || event.key === 'ArrowRight'
            ? index + 1
            : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
              ? index - 1
              : event.key === 'PageUp'
                ? index + Math.max(1, count - 1)
                : event.key === 'PageDown'
                  ? index - Math.max(1, count - 1)
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? count - 1
                      : null
        if (step === null) return
        event.preventDefault()
        commit(step)
      }}
    >
      <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex items-center justify-center" />}>
          <span
            className={cn(
              'flex flex-col justify-end gap-px transition-opacity duration-150 motion-reduce:transition-none',
              props.size === 'xs' ? 'h-4 w-2.5' : 'h-5 w-3'
            )}
            data-composer-effort-slider-meter="true"
          >
            {Array.from({ length: count }, (_, position) => {
              const levelIndex = count - 1 - position
              return (
                <span
                  key={position}
                  className={cn(
                    'w-full flex-1 rounded-[1px] bg-current transition-opacity duration-150 motion-reduce:transition-none',
                    levelIndex < filled ? 'opacity-100' : 'opacity-30'
                  )}
                  data-composer-effort-slider-cell={levelIndex < filled ? 'on' : 'off'}
                />
              )
            })}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="flex flex-col gap-0.5">
            <span>{tooltip}</span>
            {blocked ? null : (
              <span className="text-muted-foreground text-xs">
                {`${t('composer.t3.effort.wheel')} · ${t('composer.t3.effort.menu')}`}
              </span>
            )}
          </span>
        </TooltipPopup>
      </Tooltip>
      </TooltipProvider>
    </ComposerControl>
  )
}
