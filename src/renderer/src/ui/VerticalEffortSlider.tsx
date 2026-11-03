import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import { APPEARANCE_EVENT } from '../lib/appearance'
import { PulseField, resolveColor } from './pulse-field'
import './VerticalEffortSlider.css'

export function VerticalEffortSlider(props: {
  label: string
  title?: string
  levels: readonly string[]
  value: string
  labelOf: (level: string) => string
  describe?: (level: string) => string
  onChange: (level: string) => void
  disabled?: boolean
}) {
  const { levels, value, disabled } = props
  const [preview, setPreview] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const current = preview ?? value
  const shown = hovered ?? current
  const index = Math.max(0, levels.indexOf(current))
  const last = Math.max(1, levels.length - 1)
  const inputRef = useRef<HTMLInputElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const fieldRef = useRef<PulseField | null>(null)
  const palette = levels.join('|')
  const description = props.describe?.(shown) ?? ''

  useEffect(() => {
    const canvas = canvasRef.current
    const host = trackRef.current
    const probe = probeRef.current
    if (!canvas || !host || !probe) return
    const engine = new PulseField(canvas, host, true)
    fieldRef.current = engine
    const paint = () => {
      const foreground = resolveColor(probe, 'var(--fg3)')
      const surface = resolveColor(probe, 'var(--surface)')
      engine.setColors({
        levels: palette.split('|').map((level) => resolveColor(probe, `var(--think-${level}, var(--fg3))`)),
        off: foreground.map((channel, i) => channel + (surface[i] - channel) * 0.5) as [number, number, number],
        dark: document.documentElement.dataset.theme === 'dark'
      })
    }
    paint()
    const themes = new MutationObserver(paint)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    window.addEventListener(APPEARANCE_EVENT, paint)
    return () => {
      themes.disconnect()
      window.removeEventListener(APPEARANCE_EVENT, paint)
      engine.dispose()
      fieldRef.current = null
    }
  }, [palette])

  useEffect(() => {
    fieldRef.current?.setLevel(index, levels.length, !!disabled)
  }, [index, palette, levels.length, disabled])

  useEffect(() => {
    inputRef.current?.setAttribute('aria-valuetext', props.labelOf(current))
  }, [current, props.labelOf])

  return (
    <div
      className="ui-veffort"
      data-disabled={disabled ? 'true' : undefined}
      style={
        {
          '--veffort-count': levels.length,
          '--veffort-tone': `var(--think-${current}, var(--fg3))`
        } as CSSProperties
      }
    >
      <div className="ui-veffort__title">{props.title ?? props.label}</div>
      <div className="ui-veffort__body">
        <Slider
          aria-label={props.label}
          orientation="vertical"
          minValue={0}
          maxValue={last}
          step={1}
          value={index}
          isDisabled={disabled}
          className="ui-veffort__slider"
          onChange={(next) => setPreview(levels[next as number] ?? null)}
          onChangeEnd={(next) => {
            setPreview(null)
            const level = levels[next as number]
            if (level && level !== value) props.onChange(level)
          }}
        >
          <span ref={probeRef} className="ui-veffort__probe" aria-hidden="true" />
          <SliderTrack ref={trackRef} className="ui-veffort__track" data-composer-effort-slider="true">
            <canvas ref={canvasRef} className="ui-veffort__field" aria-hidden="true" />
            <SliderThumb index={0} inputRef={inputRef} aria-label={props.label} className="ui-veffort__thumb" />
          </SliderTrack>
        </Slider>
        <div className="ui-veffort__stops" onPointerLeave={() => setHovered(null)}>
          {levels
            .map((level, i) => ({ level, i }))
            .reverse()
            .map(({ level, i }) => (
              <button
                key={level}
                type="button"
                tabIndex={-1}
                disabled={disabled}
                className="ui-veffort__stop"
                data-level={level}
                data-stop-state={i === index ? 'current' : i < index ? 'below' : 'above'}
                style={{ '--stop-tone': `var(--think-${level}, var(--fg3))` } as CSSProperties}
                onPointerEnter={() => setHovered(level)}
                onClick={() => {
                  setHovered(null)
                  if (level !== value) props.onChange(level)
                }}
              >
                {props.labelOf(level)}
              </button>
            ))}
        </div>
      </div>
      {description ? (
        <p className="ui-veffort__hint" data-testid="effort-description">
          {description}
        </p>
      ) : null}
    </div>
  )
}
