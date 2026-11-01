import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { SliderThumb, SliderTrack } from 'react-aria-components'
import { APPEARANCE_EVENT } from '../lib/appearance'
import { Slider } from './Slider'
import { FlipText } from './FlipText'
import { PulseField, resolveColor } from './pulse-field'
import './FluidEffortSlider.css'

export function FluidEffortSlider(props: {
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
  const shownIndex = Math.max(0, levels.indexOf(shown))
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldRef = useRef<PulseField | null>(null)
  const palette = levels.join('|')
  const last = Math.max(1, levels.length - 1)
  const description = props.describe?.(shown) ?? ''

  useEffect(() => {
    const canvas = canvasRef.current
    const host = trackRef.current
    const probe = probeRef.current
    if (!canvas || !host || !probe) return
    const engine = new PulseField(canvas, host)
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
      className="ui-fluid-effort"
      data-previewing={hovered !== null && hovered !== current ? 'true' : undefined}
      style={{ '--fluid-tone': `var(--think-${current}, var(--fg3))`, '--fluid-shown': `var(--think-${shown}, var(--fg3))` } as CSSProperties}
    >
      <div className="ui-fluid-effort__head">
        <span className="ui-fluid-effort__title">{props.title ?? props.label}</span>
        <span className="ui-fluid-effort__value" aria-live="polite">
          <FlipText text={props.labelOf(shown)} position={shownIndex} />
        </span>
      </div>
      <Slider
        aria-label={props.label}
        minValue={0}
        maxValue={last}
        step={1}
        value={index}
        isDisabled={disabled}
        onChange={(next) => setPreview(levels[next as number] ?? null)}
        onChangeEnd={(next) => {
          setPreview(null)
          const level = levels[next as number]
          if (level && level !== value) props.onChange(level)
        }}
      >
        <div className="ui-slider__row">
          <span ref={probeRef} className="ui-fluid-effort__probe" aria-hidden="true" />
          <SliderTrack ref={trackRef} className="ui-slider__track ui-fluid-effort__track" data-composer-effort-slider="true">
            <canvas ref={canvasRef} className="ui-fluid-effort__field" aria-hidden="true" />
            <SliderThumb
              index={0}
              inputRef={inputRef}
              aria-label={props.label}
              className="ui-slider__thumb ui-fluid-effort__thumb"
            />
          </SliderTrack>
        </div>
      </Slider>
      <div className="ui-fluid-effort__stops" onPointerLeave={() => setHovered(null)}>
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            className="ui-fluid-effort__stop"
            data-stop-state={i === index ? 'current' : i < index ? 'below' : 'above'}
            data-level={level}
            aria-label={props.labelOf(level)}
            style={{ left: `${(i / last) * 100}%`, '--stop-tone': `var(--think-${level}, var(--fg3))` } as CSSProperties}
            onPointerEnter={() => setHovered(level)}
            onClick={() => {
              setHovered(null)
              if (level !== value) props.onChange(level)
            }}
          />
        ))}
      </div>
      {description ? (
        <p className="ui-fluid-effort__hint" data-testid="effort-description">
          {description}
        </p>
      ) : null}
    </div>
  )
}
