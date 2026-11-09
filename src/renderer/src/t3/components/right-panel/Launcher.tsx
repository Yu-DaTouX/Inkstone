import { type DOMAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, useEffect, useEffectEvent, useState } from 'react'
import { useOptionalT } from '@/i18n'
import { Focusable, Kbd, Tooltip, TooltipHint, TooltipTrigger } from '../../../ui'
import { cx } from '@/ui/cx'
import type { LauncherAction } from './model'
import './Launcher.css'

export type { LauncherAction }

export const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = '.ui-popover, .ui-dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

type ShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey'
>

export function surfaceShortcutActionForKey<const Action extends { available: boolean; shortcut: string }>(
  actions: readonly Action[],
  event: ShortcutEvent
): Action | null {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  return actions.find((action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase()) ?? null
}

export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null
): boolean {
  return target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null
}

export function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement<DOMAttributes<HTMLElement>, string> }) {
  return (
    <TooltipTrigger>
      <Focusable>{props.trigger}</Focusable>
      <Tooltip placement="top">
        <TooltipHint label={props.reason} />
      </Tooltip>
    </TooltipTrigger>
  )
}

export function LauncherActionRow(props: {
  action: LauncherAction
  highlighted: boolean
  onHighlight: () => void
  onClearHighlight: () => void
}) {
  const { action } = props
  if (!action.available) {
    return (
      <DisabledReasonTooltip
        reason={action.disabledReason ?? ''}
        trigger={
          <div
            tabIndex={0}
            aria-disabled="true"
            className="t3-launcher__row t3-launcher__row--disabled"
          >
            <span className="t3-launcher__icon">{action.icon}</span>
            <span className="t3-launcher__label">{action.label}</span>
            <Kbd>{action.shortcut}</Kbd>
          </div>
        }
      />
    )
  }
  return (
    <div
      onMouseEnter={props.onHighlight}
      onMouseLeave={props.onClearHighlight}
    >
      <button
        type="button"
        onClick={action.onPick}
        className={cx(
          't3-launcher__row',
          props.highlighted && 't3-launcher__row--highlighted'
        )}
      >
        <span className="t3-launcher__icon">{action.icon}</span>
        <span className="t3-launcher__label">{action.label}</span>
        <Kbd>{action.shortcut}</Kbd>
      </button>
    </div>
  )
}

export interface LauncherProps {
  actions: readonly LauncherAction[]
  title?: string
  label?: string
  className?: string
}

export function Launcher(props: LauncherProps) {
  const t = useOptionalT()
  const [highlight, setHighlight] = useState(-1)
  const availableActions = props.actions.filter((action) => action.available)
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1)

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const action = surfaceShortcutActionForKey(availableActions, event)
    if (!action) return
    if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return
    const target = event.composedPath()[0] ?? event.target
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return
    event.preventDefault()
    event.stopPropagation()
    action.onPick()
  })

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (availableActions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setHighlight((highlightIndex + 1) % availableActions.length)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length
      )
      return
    }
    if (event.key === 'Enter') {
      if (event.target !== event.currentTarget) return
      const action = availableActions[highlightIndex]
      if (!action) return
      event.preventDefault()
      action.onPick()
    }
  }

  const isHighlighted = (action: LauncherAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action

  const title = props.title ?? t('panel.t3.launcherTitle')

  return (
    <div
      data-workspace-focus-default
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={props.label ?? title}
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join('')}
      className={cx(
        't3-launcher',
        props.className
      )}
    >
      <div className="t3-launcher__panel">
        <h3 className="t3-launcher__title">{title}</h3>
        <div className="t3-launcher__list">
          {props.actions.map((action) => (
            <LauncherActionRow
              key={action.kind}
              action={action}
              highlighted={isHighlighted(action)}
              onHighlight={() => setHighlight(availableActions.indexOf(action))}
              onClearHighlight={() =>
                setHighlight((current) =>
                  current === availableActions.indexOf(action) ? -1 : current
                )
              }
            />
          ))}
        </div>
      </div>
    </div>
  )
}
