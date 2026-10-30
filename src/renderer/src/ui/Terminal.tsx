import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type AsciiGlyph = '·' | '─' | '┄' | '═' | '-' | '~'
export type AsciiTone = 'dim' | 'ink'

const RULE_LENGTH = 240
const SPARK_LEVELS = ' ▁▂▃▄▅▆▇█'
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export interface AsciiRuleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  glyph?: AsciiGlyph
  tone?: AsciiTone
  label?: ReactNode
  align?: 'start' | 'center'
  leader?: boolean
}

export function AsciiRule({ glyph = '·', tone = 'dim', label, align = 'start', leader = false, className, ...rest }: AsciiRuleProps) {
  const fill = glyph.repeat(RULE_LENGTH)
  if (leader) {
    return (
      <span className={cx('ui-ascii-rule ui-ascii-rule--leader', className)} data-tone={tone} aria-hidden>
        <span className="ui-ascii-rule__fill">{fill}</span>
      </span>
    )
  }
  return (
    <div {...rest} role="separator" className={cx('ui-ascii-rule', className)} data-tone={tone} data-align={label && align === 'center' ? 'center' : 'start'}>
      {label && align === 'center' ? <span className="ui-ascii-rule__fill" aria-hidden>{fill}</span> : null}
      {label ? <span className="ui-ascii-rule__label">{label}</span> : null}
      <span className="ui-ascii-rule__fill" aria-hidden>{fill}</span>
    </div>
  )
}

export function asciiSparkGlyphs(values: readonly number[], max?: number): string[] {
  const top = max ?? Math.max(0, ...values)
  const steps = SPARK_LEVELS.length - 1
  return values.map((value) => {
    if (!(top > 0) || !(value > 0)) return SPARK_LEVELS[1]
    return SPARK_LEVELS[Math.max(1, Math.min(steps, Math.round((value / top) * steps)))]
  })
}

export interface AsciiSparkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  values: readonly number[]
  max?: number
  tone?: 'ink' | 'accent'
  label: string
  markPeak?: boolean
  cell?: number
}

export function AsciiSpark({ values, max, tone = 'ink', label, markPeak = true, cell, className, style, ...rest }: AsciiSparkProps) {
  const glyphs = asciiSparkGlyphs(values, max)
  const peak = markPeak && values.length ? values.indexOf(Math.max(...values)) : -1
  const gridStyle = cell ? ({ ...style, '--spark-cell': `${cell}px` } as CSSProperties) : style
  return (
    <span {...rest} role="img" aria-label={label} className={cx('ui-ascii-spark', className)} data-tone={tone} data-cell={cell ? '' : undefined} style={gridStyle}>
      {glyphs.map((glyph, index) => (
        <span key={index} className="ui-ascii-spark__cell" data-peak={index === peak && values[index] > 0 ? '' : undefined} data-zero={values[index] > 0 ? undefined : ''} style={{ '--i': index } as CSSProperties} aria-hidden>
          {glyph}
        </span>
      ))}
    </span>
  )
}

export interface TermSpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  label?: string
}

export function TermSpinner({ label, className, ...rest }: TermSpinnerProps) {
  return (
    <span {...rest} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cx('ui-term-spinner', className)}>
      <span className="ui-term-spinner__strip">
        {[...SPINNER_FRAMES].map((frame, index) => <span key={index}>{frame}</span>)}
      </span>
    </span>
  )
}
