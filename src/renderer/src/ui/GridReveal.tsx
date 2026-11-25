import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type JSX } from 'react'
import { cx } from './cx'
import './GridReveal.css'

export type GridRevealProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  src?: string | null
  alt?: string
  progress?: number
  aspect?: number
  inset?: number
  estimatedDuration?: number
  onRevealComplete?: () => void
  onError?: () => void
}

const CELLS = 180
const OPENING_CELLS = 4
const HOLD = 0.9
const WAIT_CAP = 0.72
const LAST_SPLIT = 0.92
const MORPH = 0.055
const SAMPLE = 128
const COLOR_MS = 420
const GUTTER_FROM = 0.35
const GUTTER_TO = 0.75
const PHOTO_FROM = 0.93

interface Cell {
  x: number
  y: number
  w: number
  h: number
  r: number
  g: number
  b: number
  tone: number
  detail: number
  splitAt: number
  parent: Cell | null
  kids: [Cell, Cell] | null
}

interface Sums {
  n: number
  r: number
  g: number
  b: number
  l: number
  l2: number
}

interface Patch {
  x: number
  y: number
  w: number
  h: number
  r: number
  g: number
  b: number
  tone: number
}

interface Scene {
  ctx: CanvasRenderingContext2D
  root: Cell
  width: number
  height: number
  scale: number
  inset: number
  dark: boolean
  clock: number
  split: number
  fade: number
  hasColors: boolean
  image: HTMLImageElement | null
}

const clamp01 = (n: number): number => (n > 0 ? (n < 1 ? n : 1) : 0)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function selfPaced(elapsed: number, duration: number): number {
  const span = duration > 0 ? duration : 1
  return HOLD * (1 - Math.exp(-elapsed / span))
}

function hash(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return n - Math.floor(n)
}

function makeCell(x: number, y: number, w: number, h: number, parent: Cell | null): Cell {
  return { x, y, w, h, r: 0, g: 0, b: 0, tone: hash(x + 3.1, y + 1.7, w * 31.7), detail: 0, splitAt: 0, parent, kids: null }
}

function buildTree(aspect: number): { root: Cell; branches: Cell[] } {
  const root = makeCell(0, 0, 1, 1, null)
  const leaves: Cell[] = [root]
  const branches: Cell[] = []
  while (leaves.length < CELLS) {
    let pick = 0
    let widest = -1
    for (let i = 0; i < leaves.length; i++) {
      const c = leaves[i]
      const area = c.w * aspect * c.h * (1 + 0.12 * hash(c.x, c.y, 7.3))
      if (area > widest) {
        widest = area
        pick = i
      }
    }
    const parent = leaves.splice(pick, 1)[0]
    const wide = parent.w * aspect >= parent.h
    const half = wide ? parent.w / 2 : parent.h / 2
    const a = wide ? makeCell(parent.x, parent.y, half, parent.h, parent) : makeCell(parent.x, parent.y, parent.w, half, parent)
    const b = wide ? makeCell(parent.x + half, parent.y, half, parent.h, parent) : makeCell(parent.x, parent.y + half, parent.w, half, parent)
    parent.kids = [a, b]
    branches.push(parent)
    leaves.push(a, b)
  }
  const opening = OPENING_CELLS - 1
  const rest = Math.max(1, branches.length - opening)
  branches.forEach((cell, i) => {
    cell.splitAt = i < opening ? -MORPH : (LAST_SPLIT * (i - opening + 1)) / rest
  })
  return { root, branches }
}

function measureTree(root: Cell, pixels: Uint8ClampedArray, size: number): void {
  const gather = (cell: Cell): Sums => {
    let s: Sums
    if (cell.kids) {
      const a = gather(cell.kids[0])
      const b = gather(cell.kids[1])
      s = { n: a.n + b.n, r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, l: a.l + b.l, l2: a.l2 + b.l2 }
    } else {
      s = { n: 0, r: 0, g: 0, b: 0, l: 0, l2: 0 }
      const x0 = Math.round(cell.x * size)
      const y0 = Math.round(cell.y * size)
      const x1 = Math.max(x0 + 1, Math.round((cell.x + cell.w) * size))
      const y1 = Math.max(y0 + 1, Math.round((cell.y + cell.h) * size))
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * size + x) * 4
          const r = pixels[i]
          const g = pixels[i + 1]
          const b = pixels[i + 2]
          const l = 0.299 * r + 0.587 * g + 0.114 * b
          s.n++
          s.r += r
          s.g += g
          s.b += b
          s.l += l
          s.l2 += l * l
        }
      }
    }
    const n = s.n || 1
    cell.r = s.r / n
    cell.g = s.g / n
    cell.b = s.b / n
    cell.detail = Math.max(0, s.l2 / n - (s.l / n) * (s.l / n))
    return s
  }
  gather(root)
}

function orderByDetail(branches: Cell[], openedBefore: number): void {
  const pending = branches.filter((c) => c.splitAt > openedBefore)
  if (pending.length < 2) return
  const slots = pending.map((c) => c.splitAt).sort((a, b) => a - b)
  const queue = pending.filter((c) => !c.parent || c.parent.splitAt <= openedBefore)
  let next = 0
  while (queue.length && next < slots.length) {
    let pick = 0
    for (let i = 1; i < queue.length; i++) if (queue[i].detail > queue[pick].detail) pick = i
    const cell = queue.splice(pick, 1)[0]
    cell.splitAt = slots[next++]
    for (const kid of cell.kids ?? []) if (kid.kids) queue.push(kid)
  }
}

function containRect(iw: number, ih: number, x: number, y: number, w: number, h: number): { dx: number; dy: number; dw: number; dh: number } {
  const s = Math.min(w / iw, h / ih)
  return { dx: x + (w - iw * s) / 2, dy: y + (h - ih * s) / 2, dw: iw * s, dh: ih * s }
}

function greyOf(tone: number, dark: boolean, clock: number): number {
  return (dark ? 30 : 228) + tone * 13 + Math.sin(clock * 1.5 + tone * 6.28) * 3
}

function drawScene(s: Scene): void {
  const { ctx, root, width, height, split } = s
  const tint = s.hasColors ? s.fade : 0
  const shade = (grey: number, target: number): number => Math.round(mix(grey, target, tint))
  const base = greyOf(root.tone, s.dark, s.clock)
  ctx.fillStyle = `rgb(${Math.round(shade(base, root.r) * 0.92)},${Math.round(shade(base, root.g) * 0.92)},${Math.round(shade(base, root.b) * 0.92)})`
  ctx.fillRect(0, 0, width, height)
  const soft = 1 - smoothstep(GUTTER_FROM, GUTTER_TO, split)
  const gutter = s.scale * soft
  const rounded = soft > 0.01 && typeof ctx.roundRect === 'function'

  const paint = (p: Patch): void => {
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    const w = Math.round(p.x + p.w) - x
    const h = Math.round(p.y + p.h) - y
    const onLeft = x <= 0
    const onTop = y <= 0
    const onRight = x + w >= width
    const onBottom = y + h >= height
    const left = onLeft ? 0 : gutter
    const top = onTop ? 0 : gutter
    const innerW = w - left - (onRight ? 0 : gutter)
    const innerH = h - top - (onBottom ? 0 : gutter)
    if (innerW <= 0 || innerH <= 0) return
    const grey = greyOf(p.tone, s.dark, s.clock)
    ctx.fillStyle = `rgb(${shade(grey, p.r)},${shade(grey, p.g)},${shade(grey, p.b)})`
    if (rounded) {
      const radius = Math.min(innerW, innerH) * 0.12 * soft
      ctx.beginPath()
      ctx.roundRect(x + left, y + top, innerW, innerH, [!onLeft && !onTop ? radius : 0, !onRight && !onTop ? radius : 0, !onRight && !onBottom ? radius : 0, !onLeft && !onBottom ? radius : 0])
      ctx.fill()
    } else ctx.fillRect(x + left, y + top, innerW, innerH)
  }

  const walk = (cell: Cell, p: Patch): void => {
    if (!cell.kids || split < cell.splitAt) {
      paint(p)
      return
    }
    const t = easeOut(clamp01((split - cell.splitAt) / MORPH))
    for (const kid of cell.kids) {
      walk(kid, {
        x: mix(p.x, kid.x * width, t),
        y: mix(p.y, kid.y * height, t),
        w: mix(p.w, kid.w * width, t),
        h: mix(p.h, kid.h * height, t),
        r: mix(p.r, kid.r, t),
        g: mix(p.g, kid.g, t),
        b: mix(p.b, kid.b, t),
        tone: mix(p.tone, kid.tone, t)
      })
    }
  }

  walk(root, { x: 0, y: 0, w: width, h: height, r: root.r, g: root.g, b: root.b, tone: root.tone })

  if (!s.image) return
  const photo = s.hasColors ? smoothstep(PHOTO_FROM, 1, split) * s.fade : s.fade
  if (photo <= 0.002) return
  const pad = s.inset * s.scale
  const fit = containRect(s.image.naturalWidth, s.image.naturalHeight, pad, pad, Math.max(1, width - pad * 2), Math.max(1, height - pad * 2))
  ctx.globalAlpha = photo
  ctx.drawImage(s.image, fit.dx, fit.dy, fit.dw, fit.dh)
  ctx.globalAlpha = 1
}

function frameColor(frame: HTMLElement): [number, number, number] {
  const found = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(frame).backgroundColor)
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : [128, 128, 128]
}

function readAverages(el: HTMLImageElement, scene: Scene, frame: HTMLElement, branches: Cell[]): boolean {
  const buffer = document.createElement('canvas')
  buffer.width = SAMPLE
  buffer.height = SAMPLE
  const ctx = buffer.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  const [r, g, b] = frameColor(frame)
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, SAMPLE, SAMPLE)
  const pad = scene.inset * scene.scale
  const fit = containRect(el.naturalWidth, el.naturalHeight, pad, pad, Math.max(1, scene.width - pad * 2), Math.max(1, scene.height - pad * 2))
  ctx.drawImage(el, (fit.dx / scene.width) * SAMPLE, (fit.dy / scene.height) * SAMPLE, (fit.dw / scene.width) * SAMPLE, (fit.dh / scene.height) * SAMPLE)
  try {
    measureTree(scene.root, ctx.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE)
    orderByDetail(branches, scene.split)
    return true
  } catch {
    return false
  }
}

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function GridReveal({
  src,
  alt = '',
  progress,
  aspect = 1.6,
  inset = 0,
  estimatedDuration = 6000,
  onRevealComplete,
  onError,
  className,
  ...props
}: GridRevealProps): JSX.Element {
  const reduce = reducedMotion()
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const frameRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progressRef = useRef(progress)
  const durationRef = useRef(estimatedDuration)
  const doneRef = useRef(onRevealComplete)
  const errorRef = useRef(onError)
  const attachRef = useRef<((url: string) => () => void) | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    progressRef.current = progress
    durationRef.current = estimatedDuration
    doneRef.current = onRevealComplete
    errorRef.current = onError
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const frame = frameRef.current
    if (!canvas || !frame) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const { root, branches } = buildTree(ratio)
    const scene: Scene = { ctx, root, width: 0, height: 0, scale: 1, inset, dark: document.documentElement.dataset.theme !== 'light', clock: 0, split: 0, fade: 0, hasColors: false, image: null }
    let loadedAt = -1

    const render = (split: number, now: number): void => {
      scene.dark = document.documentElement.dataset.theme !== 'light'
      scene.split = split
      scene.fade = loadedAt < 0 ? 0 : smoothstep(0, COLOR_MS, now - loadedAt)
      drawScene(scene)
    }

    const repaint = (): void => {
      if (!reduce) {
        render(scene.split, performance.now())
        return
      }
      const settled = loadedAt < 0 ? performance.now() : loadedAt + COLOR_MS
      render(scene.image ? 1 : WAIT_CAP, settled)
    }

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = frame.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      scene.scale = dpr
      if (w === scene.width && h === scene.height) return
      scene.width = w
      scene.height = h
      canvas.width = w
      canvas.height = h
      repaint()
    }

    resize()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    observer?.observe(frame)

    const attach = (url: string): (() => void) => {
      let cancelled = false
      const load = (withCors: boolean): void => {
        const el = new Image()
        if (withCors) el.crossOrigin = 'anonymous'
        el.decoding = 'async'
        el.onload = () => {
          if (cancelled) return
          if (!el.naturalWidth || !el.naturalHeight) {
            errorRef.current?.()
            return
          }
          scene.image = el
          loadedAt = performance.now()
          scene.hasColors = readAverages(el, scene, frame, branches)
          setLoaded(true)
          if (reduce) repaint()
        }
        el.onerror = () => {
          if (cancelled) return
          if (withCors) load(false)
          else errorRef.current?.()
        }
        el.src = url
      }
      load(true)
      return () => {
        cancelled = true
      }
    }
    attachRef.current = attach

    if (reduce) {
      repaint()
      return () => {
        attachRef.current = null
        observer?.disconnect()
      }
    }

    let frameId = 0
    let last = 0
    let elapsed = 0
    let eased = 0
    let split = 0
    let fired = false
    let stopped = false
    let visible = true

    const tick = (now: number): void => {
      frameId = requestAnimationFrame(tick)
      if (!last) last = now
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      elapsed += dt
      scene.clock = elapsed
      const ready = scene.image !== null
      const paced = progressRef.current === undefined
      let target: number
      if (ready) target = 1
      else if (paced) target = selfPaced(elapsed * 1000, durationRef.current)
      else target = Math.min(clamp01(progressRef.current as number), HOLD)
      eased += (target - eased) * (1 - Math.exp(-dt * 5.5))
      const wanted = Math.min(eased, ready ? 1 : WAIT_CAP)
      split += (wanted - split) * (1 - Math.exp(-dt * 4))
      render(split, now)
      if (!fired && ready && eased > 0.995 && now - loadedAt > COLOR_MS) {
        fired = true
        doneRef.current?.()
      }
      if (fired && split > 0.9995) {
        render(1, now)
        stopped = true
        cancelAnimationFrame(frameId)
      }
    }

    const start = (): void => {
      if (stopped) return
      last = 0
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(tick)
    }

    const visibility = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting === visible) return
        visible = entry.isIntersecting
        if (visible) start()
        else cancelAnimationFrame(frameId)
      }, { rootMargin: '150px' })
      : null
    visibility?.observe(frame)
    start()

    return () => {
      attachRef.current = null
      cancelAnimationFrame(frameId)
      observer?.disconnect()
      visibility?.disconnect()
    }
  }, [reduce, ratio, inset])

  useEffect(() => {
    setLoaded(false)
    if (!src) return undefined
    return attachRef.current?.(src)
  }, [src, reduce, ratio, inset])

  useEffect(() => {
    if (reduce && loaded) doneRef.current?.()
  }, [reduce, loaded])

  return (
    <div ref={frameRef} data-slot="grid-reveal" className={cx('ui-grid-reveal', className)} {...props}>
      <canvas ref={canvasRef} className="ui-grid-reveal__canvas" {...(alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true })} />
    </div>
  )
}
