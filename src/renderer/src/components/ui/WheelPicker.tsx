import { useEffect, useLayoutEffect, useRef } from 'react'

const STOP_H = 22
const WHEEL_COOLDOWN_MS = 220

export function WheelPicker<T extends string>({ values, value, onChange, format, label, disabled, testId, stopTestPrefix = 'wheel' }: {
  values: readonly T[]; value: T; onChange(value: T): void; format(value: T): string
  label: string; disabled?: boolean; testId?: string; stopTestPrefix?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const selected = Math.max(0, values.indexOf(value))
  const latest = useRef({ selected, values, onChange, disabled })
  latest.current = { selected, values, onChange, disabled }
  const mounted = useRef(false)
  useLayoutEffect(() => {
    const smooth = mounted.current && !matchMedia('(prefers-reduced-motion: reduce)').matches
    mounted.current = true
    root.current?.scrollTo({ top: selected * STOP_H, behavior: smooth ? 'smooth' : 'auto' })
  }, [selected])
  useEffect(() => {
    const el = root.current
    if (!el) return
    let frame = 0
    const paint = () => {
      frame = 0
      const pos = el.scrollTop / STOP_H
      Array.from(el.children).forEach((child, i) => {
        const d = Math.max(-3, Math.min(3, i - pos))
        ;(child as HTMLElement).style.setProperty('--d', d.toFixed(3))
        ;(child as HTMLElement).style.setProperty('--a', Math.abs(d).toFixed(3))
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    paint()
    el.addEventListener('scroll', schedule, { passive: true })
    return () => { el.removeEventListener('scroll', schedule); if (frame) cancelAnimationFrame(frame) }
  }, [values.length])
  useEffect(() => {
    const el = root.current
    if (!el) return
    let last = 0
    let acc = 0
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { selected: at, values: list, onChange: change, disabled: off } = latest.current
      if (off) return
      acc += event.deltaY
      const now = performance.now()
      if (now - last < WHEEL_COOLDOWN_MS || Math.abs(acc) < 4) return
      const next = Math.max(0, Math.min(list.length - 1, at + (acc > 0 ? 1 : -1)))
      acc = 0; last = now
      if (next !== at) change(list[next])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const choose = (next: number) => {
    const stop = Math.max(0, Math.min(values.length - 1, next))
    if (values[stop] !== value) onChange(values[stop])
  }
  return <div className="ui-wheel" data-disabled={disabled ? '1' : '0'}>
    <div ref={root} className="ui-wheel-scroll" role="listbox" tabIndex={disabled ? -1 : 0}
      aria-label={label} aria-disabled={disabled} data-testid={testId}
      onKeyDown={event => {
        if (disabled || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        choose(event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : selected + (event.key === 'ArrowDown' ? 1 : -1))
      }}>
      {values.map((stop, i) => <button key={stop} type="button" role="option" aria-selected={i === selected}
        tabIndex={-1} disabled={disabled} className="ui-wheel-stop" data-testid={`${stopTestPrefix}-${stop}`}
        data-on={i === selected ? '1' : '0'} onClick={() => choose(i)}>{format(stop)}</button>)}
    </div>
    <span className="ui-wheel-focus" aria-hidden />
  </div>
}
