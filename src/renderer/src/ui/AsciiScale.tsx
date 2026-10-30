import type { CSSProperties, KeyboardEvent } from 'react'
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { asciiSparkGlyphs } from './Terminal'
import { cx } from './cx'
import './AsciiScale.css'

export interface AsciiScaleOption {
  id: string
  label: string
  isDisabled?: boolean
  title?: string
  testId?: string
}

export interface AsciiScaleProps {
  label: string
  options: readonly AsciiScaleOption[]
  value: string
  onChange: (id: string) => void
  onReselect?: (id: string) => void
  onPastEnd?: () => void
  isDisabled?: boolean
  tone?: string
  className?: string
  'data-testid'?: string
}

const GLYPH_WIDTH = 3

const PAST_END_KEYS = new Set(['ArrowRight', 'ArrowUp', 'End', 'PageUp'])

export function AsciiScale({
  label,
  options,
  value,
  onChange,
  onReselect,
  onPastEnd,
  isDisabled,
  tone,
  className,
  'data-testid': testId
}: AsciiScaleProps) {
  const glyphs = asciiSparkGlyphs(options.map((_, index) => index + 1), options.length + 1)
  const selectedIndex = options.findIndex((option) => option.id === value)
  const lastEnabled = options.reduce((last, option, index) => (option.isDisabled ? last : index), -1)
  const select = (keys: Set<Key>): void => {
    const next = [...keys][0]
    if (next != null && String(next) !== value) onChange(String(next))
  }
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!onPastEnd || !PAST_END_KEYS.has(event.key)) return
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-scale-id]')?.dataset.scaleId
    if (id !== value || selectedIndex !== lastEnabled) return
    event.preventDefault()
    event.stopPropagation()
    onPastEnd()
  }
  return (
    <div
      className={cx('ui-ascii-scale', className)}
      style={tone ? ({ '--ui-scale-tone': tone } as CSSProperties) : undefined}
      onKeyDownCapture={onKeyDownCapture}
      data-testid={testId}
    >
      <ToggleButtonGroup
        aria-label={label}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={selectedIndex >= 0 ? [value] : []}
        onSelectionChange={select}
        isDisabled={isDisabled}
        className="ui-ascii-scale__group"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, options.length)}, minmax(0, 1fr))` }}
      >
        {options.map((option, index) => (
          <span key={option.id} className="ui-ascii-scale__slot" title={option.title}>
            <ToggleButton
              id={option.id}
              isDisabled={option.isDisabled}
              className="ui-ascii-scale__cell"
              data-scale-id={option.id}
              data-lit={selectedIndex >= 0 && index <= selectedIndex ? '' : undefined}
              data-testid={option.testId}
              aria-label={option.title ? `${option.label} · ${option.title}` : option.label}
              onPress={() => {
                if (option.id === value) onReselect?.(option.id)
              }}
            >
              <span className="ui-ascii-scale__glyph" aria-hidden>
                {glyphs[index].repeat(GLYPH_WIDTH)}
              </span>
              <span className="ui-ascii-scale__label">{option.label}</span>
            </ToggleButton>
          </span>
        ))}
      </ToggleButtonGroup>
    </div>
  )
}
