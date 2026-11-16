import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { useT } from '../../i18n'
import { cancelClockFrame, requestClockFrame } from '../../lib/frame-clock'
import { prefersReducedMotion, subscribeReducedMotion } from '../../lib/reduced-motion'
import { canvasColor, canvasDark, subscribeCanvasTheme, subscribePixelRatio } from '../../lib/canvas-colors'
import tokens from '../../design/tokens.json'
import { modelCellCounts, modelThroughput, type WorkflowModelCall, type WorkflowModelStats } from '../../../../shared/workflows'
import { Button, Notice } from '../../ui'
import { MODEL_GRID_FRAME_MS, modelGridBreath, modelGridCellAt, modelGridGeometry, type ModelGridGeometry } from './model-grid-layout'

interface GridPalette {
  queued: string
  running: string
  done: string
  failed: string
}

type T = ReturnType<typeof useT>

function palette(scope: Element | null): GridPalette {
  const pickOf = (pair: readonly string[]): string => pair[canvasDark() ? 1 : 0] ?? pair[0]
  return {
    queued: canvasColor('--fg3', pickOf(tokens.color.fg3), scope),
    running: canvasColor('--run', pickOf(tokens.color.run), scope),
    done: canvasColor('--ok', pickOf(tokens.color.ok), scope),
    failed: canvasColor('--fail', pickOf(tokens.color.fail), scope)
  }
}

function paintGrid(canvas: HTMLCanvasElement, cells: string, g: ModelGridGeometry, colors: GridPalette, breathe: boolean, now: number): void {
  const dpr = window.devicePixelRatio || 1
  const step = g.size + g.gap
  const width = Math.max(1, Math.round((g.cols * step - g.gap) * dpr))
  const height = Math.max(1, Math.round(g.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const cell = Math.max(1, Math.round(g.size * dpr))
  const line = Math.max(1, Math.round(dpr))
  const at = (n: number): number => Math.round(n * step * dpr)
  const done = new Path2D()
  const failed = new Path2D()
  const stopped = new Path2D()
  const queued = new Path2D()
  const running: number[] = []
  for (let i = 0; i < cells.length; i++) {
    const x = at(i % g.cols)
    const y = at(Math.floor(i / g.cols))
    const code = cells.charCodeAt(i)
    if (code === 100 || code === 99) done.rect(x, y, cell, cell)
    else if (code === 102) failed.rect(x, y, cell, cell)
    else if (code === 115) stopped.rect(x, y, cell, cell)
    else if (code === 114) running.push(i)
    else queued.rect(x + line / 2, y + line / 2, cell - line, cell - line)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = colors.done
  ctx.fill(done)
  ctx.fillStyle = colors.failed
  ctx.fill(failed)
  ctx.globalAlpha = 0.35
  ctx.fillStyle = colors.queued
  ctx.fill(stopped)
  ctx.globalAlpha = 0.75
  ctx.lineWidth = line
  ctx.strokeStyle = colors.queued
  ctx.stroke(queued)
  ctx.fillStyle = colors.running
  for (const i of running) {
    ctx.globalAlpha = breathe ? modelGridBreath(now, i) : 1
    ctx.fillRect(at(i % g.cols), at(Math.floor(i / g.cols)), cell, cell)
  }
  ctx.globalAlpha = 1
}

function formatTime(t: T, ms: number): string {
  const seconds = Math.max(0, ms / 1000)
  if (seconds < 60) return t('wf.grid.sec', { s: seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds)) })
  const whole = Math.round(seconds)
  return t('wf.grid.minSec', { m: Math.floor(whole / 60), s: whole % 60 })
}

function formatCost(cost: number): string {
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

function useModelCall(runId: string, index: number, code: string | undefined): WorkflowModelCall | null {
  const [call, setCall] = useState<WorkflowModelCall | null>(null)
  useEffect(() => {
    setCall(null)
    if (index < 0 || typeof window.yan?.workflows?.modelCall !== 'function') return undefined
    let alive = true
    const timer = window.setTimeout(() => {
      void window.yan.workflows.modelCall(runId, index).then((found) => {
        if (alive) setCall(found)
      }).catch(() => undefined)
    }, 60)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [runId, index, code])
  return call
}

function cellState(t: T, code: string | undefined, call: WorkflowModelCall | null, now: number): string {
  if (code === 'r') return call?.startedAt ? t('wf.grid.runningFor', { time: formatTime(t, now - call.startedAt) }) : t('wf.grid.running')
  if (code === 'd') return call?.startedAt && call.endedAt ? `${t('wf.grid.done')} · ${t('wf.grid.took', { time: formatTime(t, call.endedAt - call.startedAt) })}` : t('wf.grid.done')
  if (code === 'c') return `${t('wf.grid.done')} · ${t('wf.grid.cached')}`
  if (code === 'f') return t('wf.grid.failedHint')
  if (code === 's') return t('wf.grid.stoppedHint')
  return t('wf.grid.queuedHint')
}

export function WorkflowModelGrid({ runId, models, live, running, open }: { runId: string; models: WorkflowModelStats; live: boolean; running: boolean; open: boolean }): JSX.Element | null {
  const t = useT()
  const cells = models.cells ?? ''
  const count = cells.length
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastPaint = useRef(0)
  const [width, setWidth] = useState(0)
  const [appearance, setAppearance] = useState(0)
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const [visible, setVisible] = useState(true)
  const [hover, setHover] = useState(-1)
  const [pinned, setPinned] = useState(-1)
  const geometry = useMemo(() => modelGridGeometry(count, width || 320), [count, width])
  const counts = useMemo(() => modelCellCounts(cells), [cells])
  const colors = useMemo(() => {
    void appearance
    return palette(canvasRef.current)
  }, [appearance])
  const hoverCall = useModelCall(runId, hover, hover >= 0 ? cells[hover] : undefined)
  const pinnedCall = useModelCall(runId, pinned, pinned >= 0 ? cells[pinned] : undefined)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return undefined
    setWidth(Math.floor(wrap.getBoundingClientRect().width))
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const bump = (): void => setAppearance((n) => n + 1)
    const offTheme = subscribeCanvasTheme(bump)
    const offRatio = subscribePixelRatio(bump)
    const offMotion = subscribeReducedMotion(() => setReduced(prefersReducedMotion()))
    bump()
    return () => {
      offTheme()
      offRatio()
      offMotion()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  const animate = live && counts.running > 0 && !reduced && visible
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !count || !visible) return undefined
    let timer = 0
    let frame = 0
    let stopped = false
    const paint = (now: number): void => {
      frame = 0
      if (stopped) return
      lastPaint.current = performance.now()
      paintGrid(canvas, cells, geometry, colors, animate, now)
      if (animate) timer = window.setTimeout(() => { frame = requestClockFrame(paint) }, MODEL_GRID_FRAME_MS)
    }
    const wait = MODEL_GRID_FRAME_MS - (performance.now() - lastPaint.current)
    if (wait <= 0) paint(performance.now())
    else timer = window.setTimeout(() => { frame = requestClockFrame(paint) }, wait)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      if (frame) cancelClockFrame(frame)
    }
  }, [cells, count, geometry, colors, animate, visible])

  useEffect(() => {
    if (pinned >= count) setPinned(-1)
  }, [pinned, count])

  if (!count) return null

  const indexAt = (event: ReactMouseEvent<HTMLCanvasElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return modelGridCellAt(geometry, event.clientX - rect.left, event.clientY - rect.top, count)
  }
  const now = Date.now()
  const pace = running ? modelThroughput(models, now) : { perMinute: 0, etaMs: null }
  const rate = [
    pace.perMinute > 0 ? t('wf.grid.rate', { n: pace.perMinute < 10 ? pace.perMinute.toFixed(1) : String(Math.round(pace.perMinute)) }) : null,
    pace.etaMs !== null ? t('wf.grid.eta', { time: formatTime(t, pace.etaMs) }) : null,
    models.cost ? t('wf.grid.cost', { cost: formatCost(models.cost) }) : null
  ].filter((part): part is string => !!part)
  const failures = models.failures ?? []
  const knownLabel = (index: number): string | undefined => failures.find((item) => item.index === index)?.label ?? (models.latest?.index === index ? models.latest.label : undefined)
  const nameOf = (index: number, label?: string): string => label || knownLabel(index) || t('wf.grid.cell', { n: index + 1 })
  const pinnedError = pinned >= 0 ? pinnedCall?.error ?? failures.find((item) => item.index === pinned)?.error ?? '' : ''
  const legend: [string, string, number][] = [
    ['queued', t('wf.grid.queued'), counts.queued],
    ['running', t('wf.grid.running'), counts.running],
    ['done', t('wf.grid.done'), counts.done],
    ['failed', t('wf.grid.failed'), counts.failed]
  ]
  if (counts.stopped) legend.push(['stopped', t('wf.grid.stopped'), counts.stopped])
  const summary = t('wf.grid.summary', { total: count, queued: counts.queued, running: counts.running, done: counts.done, failed: counts.failed })

  let probe: JSX.Element | null = null
  if (hover >= 0) {
    probe = <><span className="v3-wf-mgrid-name">{nameOf(hover, hoverCall?.label)}</span><span className="v3-wf-mgrid-text">{cellState(t, cells[hover], hoverCall, now)}</span></>
  } else if (models.latest) {
    probe = <><span className="v3-wf-mgrid-name">{nameOf(models.latest.index, models.latest.label)}</span><span className="v3-wf-mgrid-text">{models.latest.text}</span></>
  } else if (live) {
    probe = <span className="v3-wf-mgrid-text">{t('wf.grid.waiting')}</span>
  }

  return (
    <section className="v3-wf-mgrid" aria-label={t('wf.grid.label')} data-testid="v3-workflow-model-grid">
      <div className="v3-wf-mgrid-legend" data-testid="v3-workflow-model-legend">
        {legend.map(([state, label, n]) => (
          <span key={state} className="v3-wf-mgrid-key" data-state={state}>
            <i className="v3-wf-mgrid-swatch" data-state={state} aria-hidden="true" />
            {label}
            <b>{n}</b>
          </span>
        ))}
      </div>
      {rate.length ? <div className="v3-wf-mgrid-rate" data-testid="v3-workflow-model-rate">{rate.join(' · ')}</div> : null}
      <div ref={wrapRef} className="v3-wf-mgrid-wrap">
        <canvas
          ref={canvasRef}
          className="v3-wf-mgrid-canvas"
          role="img"
          aria-label={summary}
          data-testid="v3-workflow-model-canvas"
          data-cols={geometry.cols}
          data-step={geometry.size + geometry.gap}
          data-pointer={hover >= 0 && cells[hover] === 'f' ? 'failed' : undefined}
          style={{ width: geometry.cols * (geometry.size + geometry.gap) - geometry.gap, height: geometry.height }}
          onPointerMove={(event) => {
            const index = indexAt(event)
            if (index !== hover) setHover(index)
          }}
          onPointerLeave={() => setHover(-1)}
          onClick={(event) => {
            const index = indexAt(event)
            setPinned(index >= 0 && cells[index] === 'f' ? index : -1)
          }}
        />
      </div>
      {probe ? <p className="v3-wf-mgrid-probe" data-testid="v3-workflow-model-probe">{probe}</p> : null}
      {pinned >= 0 ? (
        <Notice
          tone="fail"
          compact
          icon={false}
          role="group"
          aria-label={t('wf.grid.errorOf', { cell: nameOf(pinned, pinnedCall?.label) })}
          title={t('wf.grid.errorOf', { cell: nameOf(pinned, pinnedCall?.label) })}
          action={<Button size="xs" variant="ghost" onPress={() => setPinned(-1)}>{t('wf.grid.close')}</Button>}
          data-testid="v3-workflow-model-error"
        >
          <pre className="v3-wf-mgrid-error-text">{pinnedError}</pre>
        </Notice>
      ) : null}
      {open && failures.length ? (
        <section className="v3-wf-mgrid-failures" tabIndex={0} aria-label={t('wf.grid.failures')} data-testid="v3-workflow-model-failures">
          <h4 className="v3-wf-mgrid-failures-title">{`${t('wf.grid.failures')} · ${counts.failed}`}</h4>
          <ol className="v3-wf-mgrid-failure-list">
            {failures.map((item) => (
              <li key={item.index} className="v3-wf-mgrid-failure">
                <span className="v3-wf-mgrid-name">{nameOf(item.index, item.label)}</span>
                <pre className="v3-wf-mgrid-error-text">{item.error}</pre>
              </li>
            ))}
          </ol>
          {counts.failed > failures.length ? <p className="v3-wf-mgrid-more">{t('wf.grid.failuresMore', { n: failures.length, total: counts.failed })}</p> : null}
        </section>
      ) : null}
    </section>
  )
}
