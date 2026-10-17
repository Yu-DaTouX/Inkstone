import formsJson from './bot-forms.json'
import type { ModelBrand } from '../../../../shared/model-brand'

export type BotMood = 'wake' | 'work' | 'ask' | 'done' | 'fail' | 'rest'

export type BotTool = 'command' | 'read' | 'edit'

export interface BotActivity {
  look: BotTool
  id: string
}

export interface ToolState {
  look: BotTool | null
  id: string
  until: number
}

type Pair = [number, number]

export interface BotFin {
  root: Pair
  angle: number
  length: number
  base: number
  tip: number
  sweep: number
}

export interface BotForm {
  center: Pair
  radius: number
  reach: number
  spin: number
  face: Pair
  cross: boolean
  mono: boolean
  paint?: string
  field?: string
  rect?: [number, number, number]
  eyeColor?: string
  stroke?: string
  ring?: [number, number, number, number, number]
  keeps?: [number, number, number, number]
  fins?: { color: string; parts: BotFin[] }
  belly?: { color: string; rect: [number, number, number, number, number] }
  logo: number[]
  body: number[]
  art: string
}

export interface BotPose {
  morph: number
  turn: number
  yaw: number
  pitch: number
  open: number
  wide: number
  happy: number
  crossed: number
  dx: number
  dy: number
  scale: number
  hop: number
}

export interface BotLook {
  form: BotForm
  paint: string
  dark: boolean
  art: CanvasImageSource | null
  field: CanvasImageSource | null
}

export const BOT_FORMS = (formsJson as unknown as { brands: Record<ModelBrand, BotForm> }).brands

export const MONO_INK = { light: '#1d1d1f', dark: '#f2f2f4' } as const

const SAMPLES = 360
const EYE_INK = '#0d0d0f'
const EYE_SPREAD = 0.34
const EYE_SIZE = 0.78
const DIRS = Array.from({ length: SAMPLES }, (_, i) => [Math.cos((i * 2 * Math.PI) / SAMPLES), Math.sin((i * 2 * Math.PI) / SAMPLES)] as Pair)

export const WAKE_SECONDS = 1.6
export const SHAKE_SECONDS = 0.5
export const BLEND_SECONDS = 0.35
export const TOOL_LINGER_SECONDS = 10
export const IDLE_TOOL: ToolState = { look: null, id: '', until: 0 }

const COMMAND_BEAT = 0.5
const COMMAND_BURST = 3
const COMMAND_PAUSE = 1.5
const COMMAND_CALM_AFTER = 20
const COMMAND_CALM_BEAT = 1.2
const READ_SACCADE = 0.2
const READ_STEPS = 7
const READ_LINE = READ_SACCADE * READ_STEPS
const READ_RETURN = 0.3
const READ_LINES = 4
const EDIT_TAP = 0.8

export function ease(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

export function luminance(color: string): number {
  const hex = color.replace('#', '')
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex.slice(0, 6), 16)
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

function blink(t: number, seed: number): number {
  const p = (t + seed) % 4.1
  return p < 0.12 ? (Math.abs(p - 0.06) / 0.06) * 0.92 + 0.08 : 1
}

export function restingPose(): BotPose {
  return { morph: 1, turn: 0, yaw: 0, pitch: 0, open: 1, wide: 1, happy: 0, crossed: 0, dx: 0, dy: 0, scale: 1, hop: 0 }
}

export function isLooping(mood: BotMood): boolean {
  return mood === 'work' || mood === 'ask'
}

export interface PoseClock {
  t: number
  seed: number
  since: number
  entrance: boolean
  restTurn: number
  still: boolean
}

export function followTool(state: ToolState, incoming: BotActivity | null, t: number): ToolState {
  if (incoming) {
    if (incoming.look === state.look && incoming.id === state.id) return state.until ? { ...state, until: 0 } : state
    return { look: incoming.look, id: incoming.id, until: 0 }
  }
  if (!state.look) return state
  if (!state.until) return { ...state, until: t + TOOL_LINGER_SECONDS }
  return t >= state.until ? IDLE_TOOL : state
}

function burstTime(elapsed: number): number {
  const cycle = COMMAND_BURST + COMMAND_PAUSE
  return Math.floor(elapsed / cycle) * COMMAND_BURST + Math.min(elapsed % cycle, COMMAND_BURST)
}

function commandPose(pose: BotPose, form: BotForm, elapsed: number, restTurn: number): void {
  const calm = ease((elapsed - COMMAND_CALM_AFTER) / 1.5)
  const bursting = elapsed % (COMMAND_BURST + COMMAND_PAUSE) < COMMAND_BURST
  const bounce = bursting ? Math.sin(Math.PI * ((elapsed % COMMAND_BEAT) / COMMAND_BEAT)) : 0
  const breathe = Math.sin(Math.PI * ((elapsed % COMMAND_CALM_BEAT) / COMMAND_CALM_BEAT)) ** 2
  const spun = elapsed < COMMAND_CALM_AFTER ? burstTime(elapsed) : burstTime(COMMAND_CALM_AFTER) + 0.35 * (elapsed - COMMAND_CALM_AFTER)
  pose.pitch = 0.06
  pose.dy = -0.05 * bounce * (1 - calm) - 0.02 * breathe * calm
  pose.turn = restTurn + form.spin * 1.5 * spun
}

function readPose(pose: BotPose, form: BotForm, elapsed: number): void {
  const cycle = READ_LINE + READ_RETURN
  const n = Math.floor(elapsed / cycle)
  const p = elapsed - n * cycle
  const line = n % READ_LINES
  const reach = form.reach * 0.38
  const row = (at: number): number => 0.02 + at * 0.06
  if (p < READ_LINE) {
    const step = Math.min(READ_STEPS - 1, Math.floor(p / READ_SACCADE))
    const k = (step + ease((p - step * READ_SACCADE) / (READ_SACCADE * 0.4))) / READ_STEPS
    pose.yaw = reach * (2 * k - 1)
    pose.pitch = row(line)
    return
  }
  const k = ease((p - READ_LINE) / READ_RETURN)
  const next = (line + 1) % READ_LINES
  pose.yaw = reach * (1 - 2 * k)
  pose.pitch = row(line + (next - line) * k)
  if (next === 0) pose.open = Math.min(pose.open, 1 - 0.85 * Math.sin(Math.PI * k))
}

function editPose(pose: BotPose, form: BotForm, elapsed: number): void {
  const p = (elapsed % EDIT_TAP) / EDIT_TAP
  const tap = p < 0.3 ? Math.sin((Math.PI * p) / 0.3) : 0
  pose.pitch = 0.1 + 0.1 * tap
  pose.dy = 0.03 * tap
  pose.yaw = form.reach * 0.12 * Math.sin((2 * Math.PI * elapsed) / 3.2)
}

function thinkingPose(pose: BotPose, form: BotForm, t: number, seed: number, elapsed: number, restTurn: number): void {
  const phase = (t + seed) % 5
  const target = phase < 2.5 ? 1 : -1
  const k = ease((phase % 2.5) / 0.5)
  pose.turn = restTurn + form.spin * elapsed
  pose.yaw = form.reach * 0.42 * (target * k - target * (1 - k))
  pose.dy = -0.012 * Math.sin((t * 2 * Math.PI) / 1.2)
}

export function poseAt(mood: BotMood, form: BotForm, clock: PoseClock, tool: BotTool | null = null): BotPose {
  const { t, seed, since, entrance, restTurn, still } = clock
  const pose = restingPose()
  const elapsed = t - since
  pose.turn = restTurn
  if (mood === 'work') {
    pose.pitch = -0.12
    if (still) return pose
    pose.open = blink(t, seed)
    const spent = Math.max(0, elapsed)
    if (tool === 'command') commandPose(pose, form, spent, restTurn)
    else if (tool === 'read') readPose(pose, form, spent)
    else if (tool === 'edit') editPose(pose, form, spent)
    else thinkingPose(pose, form, t, seed, elapsed, restTurn)
  } else if (mood === 'ask') {
    pose.wide = 1.12
    pose.scale = 1.06
    pose.pitch = -0.05
    if (still) return pose
    const phase = (t + seed) % 2.6
    const hop = phase < 0.36 ? Math.sin((phase / 0.36) * Math.PI) : 0
    pose.turn = restTurn + form.spin * elapsed
    pose.open = blink(t, seed)
    pose.dy = -0.07 * hop
    pose.hop = 0.04 * hop
  } else if (mood === 'done') {
    pose.happy = 1
  } else if (mood === 'fail') {
    if (form.cross) pose.crossed = 1
    else pose.open = 0.35
    pose.dy = 0.03
    if (!still && entrance && elapsed < SHAKE_SECONDS) pose.dx = 0.025 * Math.sin(elapsed * 6 * 2 * Math.PI) * (1 - elapsed / SHAKE_SECONDS)
  } else if (mood === 'rest') {
    pose.open = 0.08
  } else if (mood === 'wake' && entrance && !still) {
    pose.morph = elapsed < 0.5 ? 0 : ease((elapsed - 0.5) / 0.6)
    if (elapsed > 1.1 && elapsed < 1.5) pose.dy = -0.05 * Math.sin(((elapsed - 1.1) / 0.4) * Math.PI)
  }
  return pose
}

export function settlesAt(mood: BotMood, entrance: boolean): number {
  if (!entrance) return 0
  return mood === 'wake' ? WAKE_SECONDS : mood === 'fail' ? SHAKE_SECONDS : 0
}

export function blendPose(from: BotPose, to: BotPose, k: number): BotPose {
  const mix = (a: number, b: number): number => a + (b - a) * k
  let delta = (((to.turn - from.turn) % 360) + 540) % 360 - 180
  if (!Number.isFinite(delta)) delta = 0
  return {
    morph: mix(from.morph, to.morph),
    turn: from.turn + delta * k,
    yaw: mix(from.yaw, to.yaw),
    pitch: mix(from.pitch, to.pitch),
    open: mix(from.open, to.open),
    wide: mix(from.wide, to.wide),
    happy: mix(from.happy, to.happy),
    crossed: mix(from.crossed, to.crossed),
    dx: mix(from.dx, to.dx),
    dy: mix(from.dy, to.dy),
    scale: mix(from.scale, to.scale),
    hop: mix(from.hop, to.hop)
  }
}

function outlinePath(ctx: CanvasRenderingContext2D, form: BotForm, S: number, eased: number, turn: number): void {
  const [cx, cy] = form.center
  ctx.beginPath()
  for (let i = 0; i < SAMPLES; i++) {
    let from = (i - turn) % SAMPLES
    if (from < 0) from += SAMPLES
    const lo = Math.floor(from) % SAMPLES
    const p = from - Math.floor(from)
    const body = form.body[lo] + (form.body[(lo + 1) % SAMPLES] - form.body[lo]) * p
    const r = form.logo[i] + (body - form.logo[i]) * eased
    const x = (cx + DIRS[i][0] * r) * S
    const y = (cy + DIRS[i][1] * r) * S
    if (i) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
  }
  ctx.closePath()
}

function bodyPath(ctx: CanvasRenderingContext2D, form: BotForm, S: number, eased: number, turn: number): void {
  if (form.rect && eased >= 1) {
    const [cx, cy] = form.center
    const [w, h, rd] = form.rect
    ctx.beginPath()
    ctx.roundRect((cx - w / 2) * S, (cy - h / 2) * S, w * S, h * S, rd * S)
    return
  }
  outlinePath(ctx, form, S, eased, turn)
}

function fillBody(ctx: CanvasRenderingContext2D, look: BotLook, S: number): void {
  if (look.field) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(look.field, -0.25 * S, -0.25 * S, 1.5 * S, 1.5 * S)
    return
  }
  ctx.fillStyle = look.paint
  ctx.fillRect(0, 0, S, S)
}

function drawFin(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, fin: BotFin): void {
  const a = (fin.angle * Math.PI) / 180
  const d: Pair = [Math.cos(a), Math.sin(a)]
  const side: Pair = [d[1], -d[0]]
  const rx = cx + fin.root[0] * R
  const ry = cy + fin.root[1] * R
  const reach = (fin.length - fin.tip) * R
  const tx = rx + d[0] * reach + side[0] * fin.sweep * R
  const ty = ry + d[1] * reach + side[1] * fin.sweep * R
  const base = fin.base * R
  const tip = fin.tip * R
  ctx.beginPath()
  ctx.moveTo(rx + side[0] * base, ry + side[1] * base)
  ctx.lineTo(tx + side[0] * tip, ty + side[1] * tip)
  ctx.lineTo(tx - side[0] * tip, ty - side[1] * tip)
  ctx.lineTo(rx - side[0] * base, ry - side[1] * base)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(rx, ry, base, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(tx, ty, tip, 0, Math.PI * 2)
  ctx.fill()
}

function drawRing(ctx: CanvasRenderingContext2D, look: BotLook, cx: number, cy: number, R: number, front: boolean): void {
  const ring = look.form.ring
  if (!ring) return
  const [rx, ry, drop, tilt, width] = ring
  ctx.save()
  ctx.translate(cx, cy + drop * R)
  ctx.rotate((tilt * Math.PI) / 180)
  ctx.strokeStyle = look.paint
  ctx.lineWidth = width * R
  ctx.beginPath()
  ctx.ellipse(0, 0, rx * R, ry * R, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export function drawBot(ctx: CanvasRenderingContext2D, look: BotLook, S: number, pose: BotPose): void {
  const { form } = look
  const [fx, fy] = form.center
  const R = form.radius * S
  const cx = fx * S
  const cy = fy * S
  ctx.clearRect(0, 0, S, S)
  ctx.save()
  ctx.translate(pose.dx * S, pose.dy * S)
  ctx.translate(cx, cy)
  ctx.scale(pose.scale, pose.scale)
  ctx.translate(-cx, -cy)
  if (pose.morph < 1 && look.art) {
    ctx.globalAlpha = 1 - pose.morph
    ctx.drawImage(look.art, 0, 0, S, S)
    ctx.globalAlpha = 1
  }
  if (pose.morph > 0) {
    ctx.globalAlpha = pose.morph
    if (pose.morph > 0.5) drawRing(ctx, look, cx, cy, R, false)
    if (form.fins) {
      ctx.fillStyle = form.fins.color
      for (const fin of form.fins.parts) drawFin(ctx, cx, cy, R, fin)
    }
    ctx.save()
    bodyPath(ctx, form, S, pose.morph, pose.turn)
    ctx.clip()
    fillBody(ctx, look, S)
    if (form.belly) {
      const [x, y, w, h, rd] = form.belly.rect
      ctx.fillStyle = form.belly.color
      ctx.beginPath()
      ctx.roundRect(cx + x * R, cy + y * R, w * R, h * R, rd * R)
      ctx.fill()
    }
    ctx.restore()
    if (form.stroke && pose.morph >= 1) {
      bodyPath(ctx, form, S, 1, 0)
      ctx.strokeStyle = form.stroke
      ctx.lineWidth = Math.max(1, S * 0.012)
      ctx.stroke()
    }
    if (pose.morph > 0.5) drawRing(ctx, look, cx, cy, R, true)
    if (form.keeps && look.art) {
      const [kx, ky, kw, kh] = form.keeps
      const W = (look.art as { width: number }).width
      ctx.drawImage(look.art, kx * W, ky * W, kw * W, kh * W, kx * S, (ky - pose.hop) * S, kw * S, kh * S)
    }
    ctx.globalAlpha = 1
    drawEyes(ctx, look, S, pose, Math.max(0, (pose.morph - 0.6) / 0.4))
  }
  ctx.restore()
}

function drawEyes(ctx: CanvasRenderingContext2D, look: BotLook, S: number, pose: BotPose, awake: number): void {
  if (awake <= 0) return
  const { form } = look
  const [fx, fy] = form.center
  const R = form.radius * S
  const cut = !form.eyeColor && look.dark
  const ink = form.eyeColor ?? EYE_INK
  ctx.save()
  if (cut) ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = ink
  ctx.strokeStyle = ink
  ctx.lineCap = 'round'
  const { yaw, pitch } = pose
  const apart = (Math.sin(yaw + EYE_SPREAD) - Math.sin(yaw - EYE_SPREAD)) * R * 0.76
  for (const side of [-1, 1]) {
    const angle = yaw + side * EYE_SPREAD
    const x = fx * S + form.face[0] * R + Math.sin(angle) * R * 0.76
    const y = fy * S + form.face[1] * R + Math.sin(pitch) * 0.62 * R
    const narrow = Math.pow(Math.max(0.25, Math.cos(angle)), 1.4)
    const tall = (0.72 + 0.28 * Math.cos(angle)) * Math.sqrt(Math.cos(pitch))
    const big = pose.wide * (0.6 + 0.4 * awake) * EYE_SIZE
    const w = 0.25 * R * big * narrow
    const h = 0.62 * R * big * tall * Math.max(0.08, pose.open) * awake
    ctx.save()
    ctx.translate(x, y)
    if (pose.happy < 0.98 && pose.crossed < 0.98) {
      ctx.globalAlpha = (1 - pose.happy) * (1 - pose.crossed)
      const hh = Math.max(h, w * 0.16)
      ctx.beginPath()
      ctx.roundRect(-w / 2, -hh / 2, w, hh, Math.min(w, hh) / 2)
      ctx.fill()
    }
    if (pose.crossed > 0.02) {
      const rr = 0.62 * R * EYE_SIZE * 0.32 * (0.6 + 0.4 * awake)
      ctx.globalAlpha = pose.crossed
      ctx.lineWidth = 0.25 * R * EYE_SIZE * 0.55
      ctx.beginPath()
      ctx.moveTo(-rr, -rr)
      ctx.lineTo(rr, rr)
      ctx.moveTo(-rr, rr)
      ctx.lineTo(rr, -rr)
      ctx.stroke()
    }
    if (pose.happy > 0.02) {
      const stroke = Math.min(0.25 * R * 0.58 * EYE_SIZE, apart * 0.2)
      const half = Math.max(stroke * 0.7, Math.min(0.25 * R * 0.8 * EYE_SIZE, apart / 2 - stroke * 1.05)) * Math.max(0.6, narrow)
      const rise = half * 0.9
      ctx.globalAlpha = pose.happy
      ctx.lineWidth = stroke
      ctx.beginPath()
      ctx.moveTo(-half, rise * 0.45)
      ctx.quadraticCurveTo(0, -rise * 1.1, half, rise * 0.45)
      ctx.stroke()
    }
    ctx.restore()
  }
  ctx.restore()
}
