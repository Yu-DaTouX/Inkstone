import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import { Button } from './Button'
import { MeterRing } from './Progress'
import { MiniBars } from './Stat'
import { SegmentBar } from './SegmentBar'
import { StatusDot, type StatusDotKind } from './StatusDot'
import { cx } from './cx'
import './Rail.css'

export type RailTone = 'ok' | 'ask' | 'fail'

export type RailGlyph =
  | { kind: 'ring'; percent: number | null; label: string }
  | { kind: 'segments'; done: number; total: number }
  | { kind: 'tasks'; states: readonly ('pending' | 'running' | 'blocked' | 'done')[] }
  | { kind: 'bars'; values: readonly number[]; pending?: number | null; slots?: number }
  | { kind: 'dot'; status: StatusDotKind }
  | { kind: 'delta'; added: number; removed: number }

export interface RailValueProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  glyph?: RailGlyph
  glyphEnd?: boolean
  value?: ReactNode
  unit?: ReactNode
  tone?: RailTone
  error?: boolean
  digits?: number
  joined?: boolean
}

function ringPercent(percent: number | null): number {
  return percent === null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent))
}

function RailGlyphMark({ glyph }: { glyph: RailGlyph }) {
  switch (glyph.kind) {
    case 'ring':
      return (
        <MeterRing
          aria-label={glyph.label}
          className="ui-rail-value__ring"
          size={14}
          strokeWidth={2}
          value={ringPercent(glyph.percent)}
          minValue={0}
          maxValue={100}
        />
      )
    case 'segments': {
      const total = Math.max(0, glyph.total)
      const done = Math.min(total, Math.max(0, glyph.done))
      return (
        <span className="ui-rail-value__track" aria-hidden="true">
          {done > 0 ? (
            <SegmentBar
              aria-label=""
              aria-hidden
              className="ui-rail-value__fill"
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
              segments={[{ key: 'done', value: 1, tone: 1 }]}
            />
          ) : null}
        </span>
      )
    }
    case 'tasks':
      return (
        <span className="ui-rail-value__tasks" aria-hidden="true" style={{ width: `${Math.min(72, Math.max(24, glyph.states.length * 6 - 2))}px` }}>
          {glyph.states.map((state, index) => <span key={index} data-state={state} />)}
        </span>
      )
    case 'bars':
      return <MiniBars className="ui-rail-value__bars" values={glyph.values} pending={glyph.pending} slots={glyph.slots} />
    case 'dot':
      return <StatusDot className="ui-rail-value__dot" kind={glyph.status} />
    case 'delta':
      return (
        <span className="ui-rail-value__delta">
          <span data-sign="add">+{glyph.added}</span>
          <span data-sign="del">−{glyph.removed}</span>
        </span>
      )
  }
}

export function RailValue({ glyph, glyphEnd, value, unit, tone, error, digits, joined, className, style, ...rest }: RailValueProps) {
  const mark = glyph ? <RailGlyphMark glyph={glyph} /> : null
  const numStyle: CSSProperties | undefined = digits ? { minWidth: `${digits}ch` } : undefined
  return (
    <span
      {...rest}
      className={cx('ui-rail-value', className)}
      data-tone={tone}
      data-error={error ? '1' : undefined}
      data-joined={joined ? '1' : undefined}
      style={style}
    >
      {glyphEnd ? null : mark}
      {value != null ? (
        <span className="ui-rail-value__num" style={numStyle}>
          {value}
        </span>
      ) : null}
      {unit != null ? <span className="ui-rail-value__unit">{unit}</span> : null}
      {glyphEnd ? mark : null}
    </span>
  )
}

export interface RailRowButtonProps {
  ref?: Ref<HTMLButtonElement>
  'aria-haspopup'?: 'menu' | 'dialog' | 'listbox' | boolean
  'aria-expanded'?: boolean
  'data-testid'?: string
}

export interface RailRowProps {
  label: string
  title?: string
  icon?: ReactNode
  dot?: StatusDotKind
  value?: ReactNode
  error?: boolean
  onPress?: () => void
  isDisabled?: boolean
  action?: ReactNode
  actionReveal?: 'always' | 'hover'
  buttonProps?: RailRowButtonProps
  className?: string
  'data-testid'?: string
  children?: ReactNode
}

export function RailRow({
  label,
  title,
  icon,
  dot,
  value,
  error,
  onPress,
  isDisabled,
  action,
  actionReveal = 'always',
  buttonProps,
  className,
  children,
  ...rest
}: RailRowProps) {
  const tip = title ?? label
  const body = (
    <>
      <span className="ui-rail-row__lead" aria-hidden="true">
        {dot ? <StatusDot kind={dot} /> : icon}
      </span>
      <span className="ui-rail-row__label">{label}</span>
      {value != null ? <span className="ui-rail-row__value">{value}</span> : null}
    </>
  )
  const { ref: buttonRef, ...buttonRest } = buttonProps ?? {}
  return (
    <li {...rest} className={cx('ui-rail-row', className)} data-error={error ? '1' : undefined} data-action-reveal={actionReveal === 'hover' ? 'hover' : undefined} title={tip}>
      {onPress ? (
        <Button
          {...buttonRest}
          ref={buttonRef}
          variant="ghost"
          size="sm"
          className="ui-rail-row__main"
          title={tip}
          isDisabled={isDisabled}
          onPress={onPress}
        >
          {body}
        </Button>
      ) : (
        <span className="ui-rail-row__main">{body}</span>
      )}
      {action != null ? <span className="ui-rail-row__action">{action}</span> : null}
      {children}
    </li>
  )
}
