import { useEffect, useLayoutEffect, useRef } from 'react'

const STOP_H = 24
/** 一次滚轮手势只走一格：两次切换之间至少间隔这么久，触控板的连续小增量也合并成一步 */
const WHEEL_COOLDOWN_MS = 220

/** Three visible rows, with the selected stop centered in a masked wheel. */
export function WheelPicker<T extends string>({ values, value, onChange, format, label, disabled, testId }: {
  values: readonly T[]; value: T; onChange(value: T): void; format(value: T): string
  label: string; disabled?: boolean; testId?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const selected = Math.max(0, values.indexOf(value))
  const latest = useRef({ selected, values, onChange, disabled })
  latest.current = { selected, values, onChange, disabled }
  const mounted = useRef(false)
  useLayoutEffect(() => {
    /* 首次打开直接落位，之后切档才平滑滚动 */
    const smooth = mounted.current && !matchMedia('(prefers-reduced-motion: reduce)').matches
    mounted.current = true
    root.current?.scrollTo({ top: selected * STOP_H, behavior: smooth ? 'smooth' : 'auto' })
  }, [selected])
  /* 原生滚动会按像素滚过好几格；改为拦截滚轮，每个手势只切一档（需要非被动监听才能阻止默认滚动） */
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
        tabIndex={-1} disabled={disabled} className="ui-wheel-stop" data-testid={`detail-${stop}`}
        data-on={i === selected ? '1' : '0'} onClick={() => choose(i)}>{format(stop)}</button>)}
    </div>
    <span className="ui-wheel-focus" aria-hidden />
  </div>
}
