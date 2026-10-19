import type { ModelBrand } from '../../../../shared/model-brand'
import { prefersReducedMotion, subscribeReducedMotion } from '../../lib/reduced-motion'
import {
  BLEND_SECONDS,
  BOT_FORMS,
  IDLE_TOOL,
  MONO_INK,
  blendPose,
  drawBot,
  ease,
  followTool,
  isLooping,
  luminance,
  poseAt,
  settlesAt,
  type BotActivity,
  type BotLook,
  type BotMood,
  type BotPose,
  type PoseClock,
  type ToolState
} from './draw'

type Theme = 'light' | 'dark'

export interface BotOptions {
  brand: ModelBrand
  mood: BotMood
  size: number
  seed: number
  tool?: BotActivity | null
  corner?: boolean
}

export interface BotHandle {
  update(options: Omit<BotOptions, 'seed' | 'corner'>): void
  dispose(): void
}

interface BotEntry {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  brand: ModelBrand
  mood: BotMood
  size: number
  corner: boolean
  seed: number
  since: number
  entrance: boolean
  restTurn: number
  tool: ToolState
  incoming: BotActivity | null
  from: BotPose | null
  shown: BotPose | null
  visible: boolean
  dirty: boolean
}

const FRAME_GAP_MS = 25
const BLURRED_GAP_MS = 120

const entries = new Set<BotEntry>()
const byCanvas = new WeakMap<Element, BotEntry>()
const images = new Map<string, HTMLImageElement>()
const looks = new Map<string, BotLook>()
let observer: IntersectionObserver | null = null
let themeObserver: MutationObserver | null = null
let unsubscribeReduced: (() => void) | null = null
let reduced = false
let theme: Theme = 'light'
let frame = 0
let pacing = 0
let focused = true

function now(): number {
  return performance.now() / 1000
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function imageOf(url: string): HTMLImageElement | null {
  const cached = images.get(url)
  if (cached) return cached.complete && cached.naturalWidth ? cached : null
  const image = new Image()
  images.set(url, image)
  image.onload = () => {
    looks.clear()
    for (const entry of entries) entry.dirty = true
    schedule()
  }
  image.src = url
  return null
}

function tinted(image: HTMLImageElement, ink: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.drawImage(image, 0, 0)
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = ink
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  return canvas
}

function lookOf(brand: ModelBrand): BotLook {
  const key = `${brand}:${theme}`
  const cached = looks.get(key)
  if (cached) return cached
  const form = BOT_FORMS[brand] ?? BOT_FORMS.pi
  const paint = form.mono ? MONO_INK[theme] : form.paint ?? MONO_INK[theme]
  const art = imageOf(form.art)
  const field = form.field ? imageOf(form.field) : null
  const look: BotLook = {
    form,
    paint,
    ink: MONO_INK[theme],
    dark: luminance(paint) < 0.35,
    art: art && form.mono ? tinted(art, paint) : art,
    field
  }
  if (art && (!form.field || field)) looks.set(key, look)
  return look
}

function clockOf(entry: BotEntry, t: number): PoseClock {
  return { t, seed: entry.seed, since: entry.since, entrance: entry.entrance, restTurn: entry.restTurn, still: reduced, size: entry.size }
}

function poseOf(entry: BotEntry, t: number): BotPose {
  const form = BOT_FORMS[entry.brand] ?? BOT_FORMS.pi
  const target = poseAt(entry.mood, form, clockOf(entry, t), entry.tool.look)
  if (!entry.from || reduced) return target
  const k = (t - entry.since) / BLEND_SECONDS
  if (k >= 1) return target
  return blendPose(entry.from, target, ease(k))
}

function retarget(entry: BotEntry, at: number): void {
  const current = entry.shown ?? poseOf(entry, at)
  entry.from = reduced ? null : current
  entry.restTurn = ((current.turn % 360) + 360) % 360
  entry.since = at
  entry.dirty = true
}

function toolOf(entry: BotEntry): BotActivity | null {
  return entry.mood === 'work' ? entry.incoming : null
}

function trackTool(entry: BotEntry, at: number): void {
  const next = followTool(entry.tool, toolOf(entry), at)
  if (next === entry.tool) return
  const changed = next.look !== entry.tool.look || next.id !== entry.tool.id
  if (changed && !reduced) retarget(entry, at)
  entry.tool = next
}

function moving(entry: BotEntry, t: number): boolean {
  if (reduced) return false
  if (isLooping(entry.mood)) return true
  const elapsed = t - entry.since
  return (!!entry.from && elapsed < BLEND_SECONDS) || elapsed < settlesAt(entry.mood, entry.entrance)
}

function paint(entry: BotEntry, t: number): void {
  if (!entry.ctx) return
  const pose = poseOf(entry, t)
  entry.shown = pose
  drawBot(entry.ctx, lookOf(entry.brand), entry.canvas.height, pose, entry.corner)
}

function tick(): void {
  frame = 0
  if (document.hidden) return
  const t = now()
  let again = false
  for (const entry of entries) {
    if (entry.tool.look) trackTool(entry, t)
    if (!entry.visible) continue
    const active = moving(entry, t)
    if (active || entry.dirty) paint(entry, t)
    entry.dirty = active
    again ||= active
  }
  if (again) pacing = window.setTimeout(() => {
    pacing = 0
    schedule()
  }, focused ? FRAME_GAP_MS : BLURRED_GAP_MS)
}

function schedule(): void {
  if (!frame && !pacing) frame = requestAnimationFrame(tick)
}

function onReducedChange(): void {
  reduced = prefersReducedMotion()
  for (const entry of entries) entry.dirty = true
  schedule()
}

function onThemeChange(): void {
  const next = readTheme()
  if (next === theme) return
  theme = next
  for (const entry of entries) entry.dirty = true
  schedule()
}

function onVisibility(): void {
  if (document.hidden) return
  for (const entry of entries) entry.dirty = true
  schedule()
}

function onBlur(): void {
  focused = false
}

function onFocus(): void {
  focused = true
  schedule()
}

function start(): void {
  focused = document.hasFocus()
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  theme = readTheme()
  reduced = prefersReducedMotion()
  unsubscribeReduced = subscribeReducedMotion(onReducedChange)
  themeObserver = new MutationObserver(onThemeChange)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  document.addEventListener('visibilitychange', onVisibility)
  observer = new IntersectionObserver((changes) => {
    for (const change of changes) {
      const entry = byCanvas.get(change.target)
      if (!entry) continue
      entry.visible = change.isIntersecting
      if (entry.visible) entry.dirty = true
    }
    schedule()
  })
}

function stop(): void {
  unsubscribeReduced?.()
  themeObserver?.disconnect()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('blur', onBlur)
  window.removeEventListener('focus', onFocus)
  if (frame) cancelAnimationFrame(frame)
  if (pacing) window.clearTimeout(pacing)
  unsubscribeReduced = null
  themeObserver = null
  observer = null
  frame = 0
  pacing = 0
}

function resize(entry: BotEntry): void {
  const backing = Math.round(entry.size * Math.max(2, window.devicePixelRatio || 1))
  if (entry.canvas.width !== backing) entry.canvas.width = backing
  if (entry.canvas.height !== backing) entry.canvas.height = backing
}

export function mountBot(canvas: HTMLCanvasElement, options: BotOptions): BotHandle {
  if (!entries.size) start()
  const t = now()
  const entry: BotEntry = {
    canvas,
    ctx: canvas.getContext('2d'),
    brand: options.brand,
    mood: options.mood,
    size: options.size,
    corner: !!options.corner,
    seed: options.seed,
    since: t,
    entrance: options.mood === 'wake' && !reduced,
    restTurn: 0,
    tool: IDLE_TOOL,
    incoming: options.tool ?? null,
    from: null,
    shown: null,
    visible: false,
    dirty: true
  }
  entry.tool = followTool(IDLE_TOOL, toolOf(entry), t)
  resize(entry)
  entries.add(entry)
  byCanvas.set(canvas, entry)
  observer?.observe(canvas)
  return {
    update(next) {
      if (next.size !== entry.size) {
        entry.size = next.size
        resize(entry)
        entry.dirty = true
      }
      if (next.brand !== entry.brand) {
        entry.brand = next.brand
        entry.dirty = true
      }
      const at = now()
      entry.incoming = next.tool ?? null
      if (next.mood !== entry.mood) {
        retarget(entry, at)
        entry.mood = next.mood
        entry.entrance = !reduced && (next.mood === 'wake' || next.mood === 'fail' || next.mood === 'done')
        entry.tool = followTool(IDLE_TOOL, toolOf(entry), at)
      } else trackTool(entry, at)
      if (entry.dirty) schedule()
    },
    dispose() {
      observer?.unobserve(canvas)
      entries.delete(entry)
      byCanvas.delete(canvas)
      if (!entries.size) stop()
    }
  }
}

export function botSeed(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return ((hash >>> 0) % 5000) / 1000
}
