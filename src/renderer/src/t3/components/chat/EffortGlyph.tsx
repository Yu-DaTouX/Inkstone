import type { SelectDescriptor } from '../../adapters/model-traits'
import type { ComposerControlSize } from './ComposerControl'

const GLYPH_HEIGHT_SM = 14
const GLYPH_HEIGHT_XS = 12
const BASELINE_INSET = 2

const NAMED_LEVELS = new Set(['ultracode', 'max'])
const OFF_LEVELS = new Set(['off', 'none'])

export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS])
  const levels = descriptor.options.filter((option) => !special.has(option.id))
  if (levels.length < 2 || current === null) return null
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id)
  const count = startsAtOff ? levels.length - 1 : levels.length
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current
    return { count, filled: count, special: label, label }
  }
  const index = levels.findIndex((option) => option.id === current)
  if (index < 0) return null
  return {
    count,
    filled: startsAtOff ? index : index + 1,
    special: null,
    label: levels[index]!.label
  }
}

export function effortBarHeights(count: number, maxBar: number): number[] {
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)))
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step)
}

export function EffortGlyph(props: {
  count: number
  filled: number
  size?: ComposerControlSize
}) {
  const height = props.size === 'xs' ? GLYPH_HEIGHT_XS : GLYPH_HEIGHT_SM
  const step = 4
  const width = step * props.count - 2
  const maxBar = height - BASELINE_INSET
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ width, height }}
      className="shrink-0 text-current"
      data-composer-effort-glyph
      data-composer-control-icon
    >
      {effortBarHeights(props.count, maxBar).map((barHeight, index) => {
        const x = index * step
        return (
          <rect
            key={x}
            x={x}
            y={maxBar - barHeight}
            width={2}
            height={barHeight}
            fill="currentColor"
            opacity={index < props.filled ? 1 : 0.4}
          />
        )
      })}
    </svg>
  )
}
