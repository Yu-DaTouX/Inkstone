import { useEffect, useRef, type ReactNode } from 'react'
import { GaugeIcon } from 'lucide-react'
import { useT } from '../../../i18n'
import type { ComposerTraitsAdapter } from '../../adapters/composer-thinking'
import { cn } from '../../lib/utils'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from './ComposerControl'
import { EffortGlyph } from './EffortGlyph'
import { focusRequestedPermission, useComposerMenuProps } from './composerEventScope'
import { useComposerMenuState } from './useComposerMenuState'

const WHEEL_STEP_INTERVAL_MS = 130
const WHEEL_STEP_DELTA = 4

export function EffortSlider(props: {
  traits: ComposerTraitsAdapter
  size: ComposerControlSize
  disabled: boolean
  hidden?: boolean
  className?: string
  extraMenuContent?: ReactNode
  extraMenuOwnsModeShortcut?: boolean
  extraMenuHint?: string
}) {
  const t = useT()
  const composerFloatingLayerProps = useComposerMenuProps()
  const { traits } = props
  const { descriptor } = traits
  const levels = traits.levels
  const count = levels.length
  const current = descriptor.currentValue
  const rawIndex = current === null ? 0 : levels.indexOf(current)
  const index = rawIndex < 0 ? count - 1 : rawIndex
  const currentLabel =
    descriptor.options.find((option) => option.id === current)?.label ?? descriptor.label
  const blocked = props.disabled || traits.busy || traits.unsupportedReason !== null
  const triggerLabel = traits.unsupportedShortLabel ?? currentLabel
  const tooltip = blocked
    ? (traits.unsupportedReason ?? `${descriptor.label}: ${currentLabel}`)
    : [`${descriptor.label}: ${currentLabel}`, props.extraMenuHint].filter(Boolean).join(' · ')

  const triggerRef = useRef<HTMLButtonElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [open, setOpen] = useComposerMenuState(props.hidden || blocked)

  const stateRef = useRef({ index, blocked, count, levels, select: traits.select })
  stateRef.current = { index, blocked, count, levels, select: traits.select }

  const commit = (position: number) => {
    const state = stateRef.current
    if (state.blocked) return
    const next = Math.min(state.count - 1, Math.max(0, position))
    const level = state.levels[next]
    if (!level || level === state.levels[state.index]) return
    state.select(level)
  }

  const levelAtPointer = (clientY: number) => {
    const node = trackRef.current
    const state = stateRef.current
    if (!node) return state.index
    const rect = node.getBoundingClientRect()
    if (rect.height <= 0) return state.index
    const ratio = (clientY - rect.top) / rect.height
    const position = Math.min(state.count - 1, Math.max(0, Math.floor(ratio * state.count)))
    return state.count - 1 - position
  }

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      commit(levelAtPointer(event.clientY))
    }
    const endDrag = () => {
      draggingRef.current = false
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [])

  useEffect(() => {
    const node = triggerRef.current
    if (!node) return
    let lastStepAt = 0
    const onWheel = (event: WheelEvent) => {
      if (stateRef.current.blocked) return
      if (Math.abs(event.deltaY) < WHEEL_STEP_DELTA) return
      event.preventDefault()
      const now = event.timeStamp || Date.now()
      if (now - lastStepAt < WHEEL_STEP_INTERVAL_MS) return
      lastStepAt = now
      const next = stateRef.current.index + (event.deltaY < 0 ? 1 : -1)
      const level = stateRef.current.levels[next]
      if (!level || level === stateRef.current.levels[stateRef.current.index]) return
      stateRef.current.select(level)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const shortcut = props.extraMenuOwnsModeShortcut
    ? 'composer.effort composer.mode'
    : 'composer.effort'

  return (
    <Menu
      open={open}
      onOpenChange={(next) => setOpen(next && !blocked)}
      onOpenChangeComplete={(isOpen) => {
        const openToPermissions =
          isOpen && triggerRef.current?.dataset.openToPermissions === 'true'
        focusRequestedPermission(isOpen, triggerRef.current)
        if (!isOpen) {
          triggerRef.current?.focus({ preventScroll: true })
          return
        }
        if (!openToPermissions) trackRef.current?.focus({ preventScroll: true })
      }}
    >
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    ref={triggerRef}
                    aria-disabled={blocked || undefined}
                    aria-label={tooltip}
                    data-composer-shortcut={shortcut}
                    data-composer-effort-trigger="true"
                    size={props.size}
                    className={cn(
                      'shrink-0 whitespace-nowrap',
                      props.className,
                      '-ms-1 ps-0.5 text-muted-foreground hover:text-foreground data-popup-open:text-foreground',
                      blocked && 'cursor-default text-muted-foreground/60 hover:text-muted-foreground/60'
                    )}
                  />
                }
              />
            }
          >
            <span className="flex items-center gap-1.5">
              {count > 1 ? (
                <span data-composer-control-compact-icon className="flex items-center">
                  <EffortGlyph count={count} filled={index + 1} size={props.size} />
                </span>
              ) : (
                <ComposerControlIcon icon={GaugeIcon} size={props.size} />
              )}
              <span data-composer-control-label>{triggerLabel}</span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            <span className="flex flex-col gap-0.5">
              <span>{tooltip}</span>
              {blocked ? null : (
                <span className="text-muted-foreground text-xs">{t('composer.t3.effort.wheel')}</span>
              )}
            </span>
          </TooltipPopup>
        </Tooltip>
      </TooltipProvider>
      <MenuPopup align="start" width="content" {...composerFloatingLayerProps}>
        <div className="flex w-44 flex-col gap-1" data-composer-effort-panel="true">
          <div className="px-2 pt-1 pb-0.5 font-medium text-muted-foreground text-xs">
            {descriptor.label}
          </div>
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label={descriptor.label}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={count - 1}
            aria-valuenow={index}
            aria-valuetext={currentLabel}
            data-composer-effort-slider="true"
            className="flex flex-col-reverse gap-0.5 rounded-md p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onPointerDown={(event) => {
              event.currentTarget.focus({ preventScroll: true })
              draggingRef.current = true
              commit(levelAtPointer(event.clientY))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setOpen(false)
                return
              }
              const position =
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
              if (position === null) return
              event.preventDefault()
              event.stopPropagation()
              commit(position)
            }}
          >
            {levels.map((level, position) => {
              const label = descriptor.options.find((option) => option.id === level)?.label ?? level
              const active = position === index
              return (
                <button
                  key={level}
                  type="button"
                  tabIndex={-1}
                  data-composer-effort-level={level}
                  data-active={active || undefined}
                  aria-current={active || undefined}
                  onClick={() => commit(position)}
                  className={cn(
                    'flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors duration-100 motion-reduce:transition-none',
                    active
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-0.5 shrink-0 rounded-full bg-current transition-opacity duration-100 motion-reduce:transition-none',
                      position <= index ? 'opacity-90' : 'opacity-25'
                    )}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
        {props.extraMenuContent ? (
          <>
            <div className="mx-2 my-1 h-px bg-border" role="separator" />
            {props.extraMenuContent}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  )
}
