import formsJson from './bot-forms.json'
import tokens from '../../design/tokens.json'
import type { ModelBrand } from '../../../../shared/model-brand'

export type BotMood = 'icon' | 'wake' | 'work' | 'ask' | 'done' | 'fail' | 'rest'

export type BotTool = 'command' | 'read' | 'edit' | 'search'

export type BotBadge = BotTool | 'think' | 'ask'

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
  squash: number
  tilt: number
  badge: BotBadge | null
  cue: number
  cueAlpha: number
  cueScale: number
}

export interface BotLook {
  form: BotForm
  paint: string
  ink?: string
  dark: boolean
  art: CanvasImageSource | null
  field: CanvasImageSource | null
}

export const BOT_FORMS = (formsJson as unknown as { brands: Record<ModelBrand, BotForm> }).brands

export const MONO_INK = { light: '#1d1d1f', dark: '#f2f2f4' } as const

const PLATE_LIGHT = tokens.color.surface[0]
const PLATE_DARK = tokens.color.fg[1]
const PLATE_RING = tokens.color.line2[0]
const GLYPH_DARK = tokens.color.fg[0]
const GLYPH_LIGHT = tokens.color['on-ink'][0]

const SAMPLES = 360
const EYE_INK = '#0d0d0f'
const EYE_SPREAD = 0.34
const EYE_SIZE = 0.78
const CROSS_SPREAD = 0.3
const DIRS = Array.from({ length: SAMPLES }, (_, i) => [Math.cos((i * 2 * Math.PI) / SAMPLES), Math.sin((i * 2 * Math.PI) / SAMPLES)] as Pair)

export const WAKE_SECONDS = 1.6
export const SHAKE_SECONDS = 0.6
export const CHEER_SECONDS = 0.6
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
const THINK_GLANCE = 2.4
const ASK_PERIOD = 1.9
const SEARCH_SWEEP = 1.6
const DEFAULT_SIZE = 32

interface Room {
  up: number
  down: number
  side: number
  widen: number
  foot: number
  height: number
}

interface Hop {
  lift: number
  squash: number
}

const rooms = new Map<BotForm, Room>()

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
  return { morph: 1, turn: 0, yaw: 0, pitch: 0, open: 1, wide: 1, happy: 0, crossed: 0, dx: 0, dy: 0, scale: 1, hop: 0, squash: 0, tilt: 0, badge: null, cue: NaN, cueAlpha: 0, cueScale: 1 }
}

export function motionGain(size = DEFAULT_SIZE): number {
  return 1 + 0.8 * Math.min(1, Math.max(0, (64 - size) / 48))
}

function measureRoom(form: BotForm): Room {
  const [cx, cy] = form.center
  const R = form.radius
  let top = 0
  let bottom = 0
  let side = 0
  let far = 0
  for (let i = 0; i < SAMPLES; i++) {
    const r = form.body[i]
    far = Math.max(far, r)
    top = Math.max(top, -DIRS[i][1] * r)
    bottom = Math.max(bottom, DIRS[i][1] * r)
    side = Math.max(side, Math.abs(DIRS[i][0]) * r)
  }
  if (form.spin) top = bottom = side = far
  if (form.rect) {
    top = bottom = form.rect[1] / 2
    side = form.rect[0] / 2
  }
  for (const fin of form.fins?.parts ?? []) {
    const a = (fin.angle * Math.PI) / 180
    const x = (fin.root[0] + Math.cos(a) * fin.length) * R
    const y = (fin.root[1] + Math.sin(a) * fin.length) * R
    top = Math.max(top, -y)
    bottom = Math.max(bottom, y)
    side = Math.max(side, Math.abs(x))
  }
  if (form.ring) side = Math.max(side, form.ring[0] * R * Math.cos((form.ring[3] * Math.PI) / 180))
  let up = cy - top
  let room = Math.min(cx, 1 - cx) - side
  if (form.keeps) {
    up = Math.min(up, form.keeps[1] + form.keeps[3] * 0.2)
    room = Math.min(room, 1 - form.keeps[0] - form.keeps[2])
  }
  room = Math.max(0, room - 0.02)
  return {
    up: Math.max(0.05, up - 0.03),
    down: Math.max(0.02, 1 - cy - bottom - 0.02),
    side: room,
    widen: Math.max(0, room - 0.02) / side,
    foot: cy + bottom,
    height: top + bottom
  }
}

function roomOf(form: BotForm): Room {
  let room = rooms.get(form)
  if (!room) {
    room = measureRoom(form)
    rooms.set(form, room)
  }
  return room
}

function hopAt(x: number, air: number, pre: number, post: number): Hop {
  if (x < -pre || x > air + post) return { lift: 0, squash: 0 }
  if (x < 0) return { lift: 0, squash: Math.sin((Math.PI * (x + pre)) / pre) }
  if (x <= air) {
    const u = x / air
    return { lift: Math.sin(Math.PI * u), squash: -Math.abs(Math.sin(2 * Math.PI * u)) }
  }
  return { lift: 0, squash: Math.sin((Math.PI * (x - air)) / post) }
}

function applyHop(pose: BotPose, form: BotForm, hop: Hop, want: number, flat: number, stretch: number, size = 1): number {
  const room = roomOf(form)
  const up = room.up - (size - 1) * room.height * 0.5
  const tall = Math.min(stretch, (up * 0.3) / room.height)
  const lift = Math.max(0.015, Math.min(want, up - tall * room.height))
  pose.dy -= lift * hop.lift
  pose.squash += hop.squash > 0 ? flat * hop.squash : tall * hop.squash
  return lift
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
  size?: number
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

function commandPose(pose: BotPose, form: BotForm, elapsed: number, restTurn: number, gain: number): void {
  const calm = ease((elapsed - COMMAND_CALM_AFTER) / 1.5)
  const bursting = elapsed % (COMMAND_BURST + COMMAND_PAUSE) < COMMAND_BURST
  const beat = elapsed % COMMAND_BEAT
  const breathe = Math.sin(Math.PI * ((elapsed % COMMAND_CALM_BEAT) / COMMAND_CALM_BEAT)) ** 2
  const spun = elapsed < COMMAND_CALM_AFTER ? burstTime(elapsed) : burstTime(COMMAND_CALM_AFTER) + 0.35 * (elapsed - COMMAND_CALM_AFTER)
  pose.pitch = 0.06 + 0.04 * gain
  pose.turn = restTurn + form.spin * 1.5 * spun
  pose.cue = elapsed
  if (bursting && calm < 1) {
    const hop = hopAt(beat - 0.07, 0.32, 0.07, 0.11)
    applyHop(pose, form, { lift: hop.lift * (1 - calm), squash: hop.squash * (1 - calm) }, 0.055 * gain, Math.min(0.09, 0.05 * gain), Math.min(0.05, 0.03 * gain))
  }
  pose.dy -= 0.015 * gain * breathe * calm
}

function readPose(pose: BotPose, form: BotForm, elapsed: number, gain: number): void {
  const cycle = READ_LINE + READ_RETURN
  const n = Math.floor(elapsed / cycle)
  const p = elapsed - n * cycle
  const line = n % READ_LINES
  const reach = Math.min(0.62, form.reach * 0.38 * gain)
  const drop = Math.min(1.7, gain)
  const row = (at: number): number => (0.02 + at * 0.065) * drop
  pose.cue = line + Math.min(1, p / READ_LINE)
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

function swayOf(form: BotForm): number {
  return Math.min(1, roomOf(form).side / 0.09)
}

function editPose(pose: BotPose, form: BotForm, elapsed: number, gain: number): void {
  const p = (elapsed % EDIT_TAP) / EDIT_TAP
  const tap = p < 0.3 ? Math.sin((Math.PI * p) / 0.3) : 0
  const sweep = Math.sin((2 * Math.PI * elapsed) / 3.2)
  pose.pitch = 0.12 + 0.14 * Math.min(1.6, gain) * tap
  pose.dy = Math.min(0.03 * gain, roomOf(form).down * 0.8) * tap
  pose.squash = Math.min(0.08, 0.045 * gain) * tap
  pose.yaw = Math.min(0.45, form.reach * 0.14 * gain) * sweep
  pose.tilt = 0.035 * gain * swayOf(form) * sweep
  pose.cue = tap
}

function searchPose(pose: BotPose, form: BotForm, elapsed: number, gain: number): void {
  const sweep = Math.sin((2 * Math.PI * elapsed) / SEARCH_SWEEP)
  const dart = Math.sin((4 * Math.PI * elapsed) / SEARCH_SWEEP)
  pose.yaw = Math.min(0.6, form.reach * 0.45 * gain) * sweep
  pose.pitch = 0.04 + 0.05 * gain * dart
  pose.dx = Math.min(roomOf(form).side * 0.7, 0.02 * gain) * sweep
  pose.tilt = 0.04 * gain * swayOf(form) * sweep
  pose.wide = 1.06
  pose.cue = sweep
}

function thinkingPose(pose: BotPose, form: BotForm, t: number, seed: number, elapsed: number, restTurn: number, gain: number): void {
  const phase = (t + seed) % (THINK_GLANCE * 2)
  const target = phase < THINK_GLANCE ? 1 : -1
  const look = target * (2 * ease((phase % THINK_GLANCE) / 0.5) - 1)
  pose.turn = restTurn + form.spin * elapsed
  pose.yaw = Math.min(0.62, form.reach * 0.42 * gain) * look
  pose.pitch = -0.12 - 0.07 * gain * Math.abs(look)
  pose.tilt = Math.min(0.14, 0.065 * gain) * swayOf(form) * look
  pose.dy = -Math.min(roomOf(form).up * 0.5, 0.016 * gain) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t + seed)) / 1.6))
  pose.cue = t + seed
}

export function poseAt(mood: BotMood, form: BotForm, clock: PoseClock, tool: BotTool | null = null): BotPose {
  const { t, seed, since, entrance, restTurn, still } = clock
  const gain = motionGain(clock.size)
  const pose = restingPose()
  const elapsed = t - since
  pose.turn = restTurn
  pose.cueScale = 1 + 0.15 * Math.min(1, Math.max(0, (32 - (clock.size ?? DEFAULT_SIZE)) / 10))
  if (mood === 'work') {
    pose.pitch = -0.12
    pose.badge = tool ?? 'think'
    pose.cueAlpha = 1
    if (still) return pose
    pose.open = blink(t, seed)
    const spent = Math.max(0, elapsed)
    if (tool === 'command') commandPose(pose, form, spent, restTurn, gain)
    else if (tool === 'read') readPose(pose, form, spent, gain)
    else if (tool === 'edit') editPose(pose, form, spent, gain)
    else if (tool === 'search') searchPose(pose, form, spent, gain)
    else thinkingPose(pose, form, t, seed, elapsed, restTurn, gain)
  } else if (mood === 'ask') {
    pose.wide = 1.12
    pose.scale = 1.05
    pose.pitch = -0.05
    pose.badge = 'ask'
    pose.cueAlpha = 1
    if (still) return pose
    const phase = (t + seed) % ASK_PERIOD
    const first = hopAt(phase - 0.1, 0.3, 0.1, 0.12)
    const second = hopAt(phase - 0.62, 0.22, 0.1, 0.1)
    const hop = { lift: first.lift + 0.6 * second.lift, squash: first.squash + 0.6 * second.squash }
    const lift = applyHop(pose, form, hop, 0.07 * gain, Math.min(0.1, 0.06 * gain), Math.min(0.04, 0.025 * gain), pose.scale)
    const sway = phase < 0.94 ? 0 : Math.sin((2 * Math.PI * (phase - 0.94)) / (ASK_PERIOD - 0.94))
    pose.turn = restTurn + form.spin * elapsed
    pose.open = blink(t, seed)
    pose.hop = 0.6 * lift * hop.lift
    pose.tilt = Math.min(0.13, 0.07 * gain) * swayOf(form) * sway
    pose.cue = phase
  } else if (mood === 'done') {
    pose.happy = 1
    if (!still && entrance && elapsed < CHEER_SECONDS) {
      applyHop(pose, form, hopAt(elapsed - 0.12, 0.28, 0.1, 0.12), 0.06 * gain, Math.min(0.1, 0.06 * gain), Math.min(0.05, 0.03 * gain))
    }
  } else if (mood === 'fail') {
    if (form.cross) pose.crossed = 1
    else pose.open = 0.35
    pose.dy = Math.min(0.03, roomOf(form).down)
    pose.pitch = 0.12
    pose.squash = 0.04
    if (!still && entrance && elapsed < SHAKE_SECONDS) {
      const fade = 1 - elapsed / SHAKE_SECONDS
      const shake = Math.sin(elapsed * 5 * 2 * Math.PI) * fade
      pose.dx = Math.min(0.04, roomOf(form).side * 0.6, 0.025 * gain) * shake
      pose.yaw = Math.min(0.4, 0.22 * gain) * shake
      pose.squash = 0.04 * (1 - fade)
    }
  } else if (mood === 'rest') {
    pose.open = 0.08
  } else if (mood === 'icon') {
    pose.morph = 0
  } else if (mood === 'wake' && entrance && !still) {
    pose.morph = elapsed < 0.5 ? 0 : ease((elapsed - 0.5) / 0.6)
    applyHop(pose, form, hopAt(elapsed - 1.18, 0.28, 0.08, 0.12), 0.06 * gain, Math.min(0.1, 0.06 * gain), Math.min(0.05, 0.03 * gain))
    if (elapsed > 1.44 && elapsed < 1.6) pose.open = 1 - 0.9 * Math.sin((Math.PI * (elapsed - 1.44)) / 0.16)
  }
  return pose
}

export function settlesAt(mood: BotMood, entrance: boolean): number {
  if (!entrance) return 0
  return mood === 'wake' ? WAKE_SECONDS : mood === 'fail' ? SHAKE_SECONDS : mood === 'done' ? CHEER_SECONDS : 0
}

function blendBadge(from: BotPose, to: BotPose, k: number): Pick<BotPose, 'badge' | 'cue' | 'cueAlpha' | 'cueScale'> {
  const cueScale = to.cueScale
  if (from.badge === to.badge) return { badge: to.badge, cue: to.cue, cueAlpha: from.cueAlpha + (to.cueAlpha - from.cueAlpha) * k, cueScale }
  if (k < 0.5) return { badge: from.badge, cue: from.cue, cueAlpha: from.cueAlpha * (1 - 2 * k), cueScale }
  return { badge: to.badge, cue: to.cue, cueAlpha: to.cueAlpha * (2 * k - 1), cueScale }
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
    hop: mix(from.hop, to.hop),
    squash: mix(from.squash, to.squash),
    tilt: mix(from.tilt, to.tilt),
    ...blendBadge(from, to, k)
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

export function drawBot(ctx: CanvasRenderingContext2D, look: BotLook, S: number, pose: BotPose, corner = false): void {
  const { form } = look
  const [fx, fy] = form.center
  const R = form.radius * S
  const cx = fx * S
  const cy = fy * S
  ctx.clearRect(0, 0, ctx.canvas.width, S)
  ctx.save()
  ctx.translate(pose.dx * S, pose.dy * S)
  if (pose.tilt || pose.squash) {
    const room = roomOf(form)
    const foot = room.foot * S
    if (pose.tilt) {
      const pivot = foot - room.height * S * 0.1
      ctx.translate(cx, pivot)
      ctx.rotate(pose.tilt)
      ctx.translate(-cx, -pivot)
    }
    if (pose.squash) {
      ctx.translate(cx, foot)
      ctx.scale(1 + Math.min(0.6 * pose.squash, room.widen), 1 - pose.squash)
      ctx.translate(-cx, -foot)
    }
  }
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
  if (corner) drawCornerBadge(ctx, look, S, pose)
  else drawBadge(ctx, look, S, pose)
}

function badgeInks(look: BotLook): [string, string] {
  let plate = look.paint
  if (look.ink && Math.abs(luminance(plate) - (1 - luminance(look.ink))) < 0.25) plate = look.ink
  return [plate, luminance(plate) > 0.6 ? EYE_INK : GLYPH_LIGHT]
}

function cutThenFill(ctx: CanvasRenderingContext2D, shape: () => void, halo: number, color: string): void {
  ctx.globalCompositeOperation = 'destination-out'
  shape()
  ctx.lineWidth = halo * 2
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  shape()
  ctx.fillStyle = color
  ctx.fill()
}

function cutThenStroke(ctx: CanvasRenderingContext2D, shape: () => void, width: number, halo: number, color: string): void {
  ctx.lineCap = 'round'
  ctx.globalCompositeOperation = 'destination-out'
  shape()
  ctx.lineWidth = width + halo * 2
  ctx.stroke()
  ctx.globalCompositeOperation = 'source-over'
  shape()
  ctx.lineWidth = width
  ctx.strokeStyle = color
  ctx.stroke()
}

function drawBadge(ctx: CanvasRenderingContext2D, look: BotLook, S: number, pose: BotPose): void {
  if (!pose.badge || pose.cueAlpha <= 0.01 || pose.morph < 1) return
  const left = !!look.form.keeps
  const toward = left ? 1 : -1
  const U = S * pose.cueScale
  const ax = (left ? 0.24 : 0.76) * S
  const ay = 0.2 * S
  const halo = Math.max(1, 0.05 * S)
  const live = Number.isFinite(pose.cue)
  const cue = live ? pose.cue : 0
  const [plate, glyph] = badgeInks(look)
  ctx.save()
  ctx.globalAlpha = pose.cueAlpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (pose.badge === 'think') {
    const w = 0.42 * U
    const h = 0.24 * U
    cutThenFill(ctx, () => {
      ctx.beginPath()
      ctx.roundRect(ax - w / 2, ay - h / 2, w, h, h / 2)
    }, halo, plate)
    ctx.fillStyle = glyph
    for (let i = 0; i < 3; i++) {
      const phase = (((cue / 1.1 - i * 0.18) % 1) + 1) % 1
      const lift = live && phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) : 0
      ctx.beginPath()
      ctx.arc(ax + (i - 1) * 0.11 * U, ay + 0.015 * U - lift * 0.05 * U, 0.034 * U, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (pose.badge === 'command') {
    const w = 0.42 * U
    const h = 0.3 * U
    cutThenFill(ctx, () => {
      ctx.beginPath()
      ctx.roundRect(ax - w / 2, ay - h / 2, w, h, 0.07 * U)
    }, halo, plate)
    const beat = cue % COMMAND_BEAT
    const bursting = cue % (COMMAND_BURST + COMMAND_PAUSE) < COMMAND_BURST
    const nudge = live && bursting ? 0.025 * U * Math.sin((Math.PI * beat) / COMMAND_BEAT) : 0
    ctx.strokeStyle = glyph
    ctx.lineWidth = 0.05 * U
    ctx.beginPath()
    ctx.moveTo(ax - 0.13 * U + nudge, ay - 0.07 * U)
    ctx.lineTo(ax - 0.05 * U + nudge, ay)
    ctx.lineTo(ax - 0.13 * U + nudge, ay + 0.07 * U)
    ctx.stroke()
    const on = !live || (bursting ? beat < COMMAND_BEAT * 0.6 : cue % 1 < 0.6)
    if (on) {
      ctx.fillStyle = glyph
      ctx.fillRect(ax + 0.01 * U, ay + 0.045 * U, 0.12 * U, 0.045 * U)
    }
  } else if (pose.badge === 'search') {
    const r = 0.095 * U
    const x = ax + cue * 0.06 * U + toward * 0.03 * U
    const y = ay - 0.02 * U
    const out = -toward * Math.SQRT1_2
    const lens = (): void => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
    const handle = (): void => {
      ctx.beginPath()
      ctx.moveTo(x + out * r * 1.05, y + Math.SQRT1_2 * r * 1.05)
      ctx.lineTo(x + out * (r + 0.11 * U), y + Math.SQRT1_2 * (r + 0.11 * U))
    }
    ctx.globalCompositeOperation = 'destination-out'
    lens()
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    cutThenStroke(ctx, lens, 0.05 * U, halo, plate)
    cutThenStroke(ctx, handle, 0.07 * U, halo, plate)
    cutThenStroke(ctx, lens, 0.05 * U, 0, plate)
  } else if (pose.badge === 'ask') {
    const r = 0.16 * U
    const x = ax + 0.02 * U
    const y = ay
    cutThenFill(ctx, () => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }, halo, plate)
    const pulse = live && cue < 0.94 ? Math.sin((Math.PI * (cue % 0.47)) / 0.47) : 0
    ctx.translate(x, y)
    ctx.rotate(live ? 0.24 * Math.sin((2 * Math.PI * cue) / 0.6) : 0)
    ctx.scale(1 + 0.15 * pulse, 1 + 0.15 * pulse)
    ctx.fillStyle = glyph
    ctx.font = `800 ${0.27 * U}px system-ui, "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    const box = ctx.measureText('?')
    ctx.fillText('?', 0, (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2)
  } else if (pose.badge === 'read') {
    const w = 0.3 * U
    const h = 0.32 * U
    ctx.translate(ax, ay + 0.01 * U)
    ctx.rotate(toward * 0.1)
    cutThenFill(ctx, () => {
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, 0.05 * U)
    }, halo, plate)
    const active = live ? Math.min(2, Math.floor((cue * 3) / READ_LINES)) : -1
    const progress = live ? cue - Math.floor(cue) : 1
    ctx.strokeStyle = glyph
    ctx.lineWidth = 0.04 * U
    for (let i = 0; i < 3; i++) {
      const y = (i - 1) * 0.095 * U
      const span = (i === 2 ? 0.1 : 0.17) * U
      ctx.globalAlpha = pose.cueAlpha * (live && i !== active ? 0.45 : 1)
      ctx.beginPath()
      ctx.moveTo(-0.085 * U, y)
      ctx.lineTo(-0.085 * U + (i === active ? Math.max(0.02 * U, span * progress) : span), y)
      ctx.stroke()
    }
  } else if (pose.badge === 'edit') {
    const L = 0.36 * U
    const W = 0.11 * U
    const tip = 0.1 * U
    const poke = live ? 0.04 * U * cue : 0
    ctx.translate(ax, ay + 0.02 * U)
    ctx.rotate(Math.atan2(1, toward))
    ctx.translate(poke, 0)
    cutThenFill(ctx, () => {
      ctx.beginPath()
      ctx.moveTo(-L / 2, -W / 2)
      ctx.lineTo(L / 2 - tip, -W / 2)
      ctx.lineTo(L / 2, 0)
      ctx.lineTo(L / 2 - tip, W / 2)
      ctx.lineTo(-L / 2, W / 2)
      ctx.closePath()
    }, halo, plate)
    ctx.strokeStyle = glyph
    ctx.lineWidth = 0.03 * U
    ctx.beginPath()
    ctx.moveTo(L / 2 - tip, -W / 2)
    ctx.lineTo(L / 2 - tip, W / 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawCornerBadge(ctx: CanvasRenderingContext2D, look: BotLook, S: number, pose: BotPose): void {
  if (!pose.badge || pose.cueAlpha <= 0.01 || pose.morph < 1) return
  const D = 0.5 * S
  const bx = S - D / 2
  const by = S - D / 2
  const halo = S / 16
  const live = Number.isFinite(pose.cue)
  const cue = live ? pose.cue : 0
  const lightTheme = !look.ink || luminance(look.ink) < 0.6
  const plate = lightTheme ? PLATE_LIGHT : PLATE_DARK
  const glyph = GLYPH_DARK
  const pop = 0.7 + 0.3 * pose.cueAlpha
  ctx.save()
  ctx.globalAlpha = pose.cueAlpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.translate(bx, by)
  ctx.scale(pop, pop)
  const disc = (): void => {
    ctx.beginPath()
    ctx.arc(0, 0, D / 2, 0, Math.PI * 2)
  }
  cutThenFill(ctx, disc, halo, plate)
  if (lightTheme) {
    ctx.strokeStyle = PLATE_RING
    ctx.lineWidth = Math.max(1, S * 0.03)
    disc()
    ctx.stroke()
  }
  ctx.fillStyle = glyph
  ctx.strokeStyle = glyph
  ctx.lineWidth = 0.15 * D
  if (pose.badge === 'think') {
    for (let i = 0; i < 3; i++) {
      const phase = (((cue / 1.1 - i * 0.18) % 1) + 1) % 1
      const lift = live && phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) : 0
      ctx.beginPath()
      ctx.arc((i - 1) * 0.28 * D, 0.01 * D - lift * 0.1 * D, 0.095 * D, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (pose.badge === 'command') {
    const beat = cue % COMMAND_BEAT
    const bursting = cue % (COMMAND_BURST + COMMAND_PAUSE) < COMMAND_BURST
    const nudge = live && bursting ? 0.06 * D * Math.sin((Math.PI * beat) / COMMAND_BEAT) : 0
    ctx.beginPath()
    ctx.moveTo(-0.12 * D + nudge, -0.22 * D)
    ctx.lineTo(0.12 * D + nudge, 0)
    ctx.lineTo(-0.12 * D + nudge, 0.22 * D)
    ctx.stroke()
  } else if (pose.badge === 'search') {
    const r = 0.2 * D
    const x = -0.07 * D + cue * 0.05 * D
    const y = -0.07 * D
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + r * Math.SQRT1_2 * 1.1, y + r * Math.SQRT1_2 * 1.1)
    ctx.lineTo(x + r * Math.SQRT1_2 + 0.15 * D, y + r * Math.SQRT1_2 + 0.15 * D)
    ctx.stroke()
  } else if (pose.badge === 'ask') {
    const pulse = live && cue < 0.94 ? Math.sin((Math.PI * (cue % 0.47)) / 0.47) : 0
    ctx.rotate(live ? 0.24 * Math.sin((2 * Math.PI * cue) / 0.6) : 0)
    ctx.scale(1 + 0.15 * pulse, 1 + 0.15 * pulse)
    ctx.font = `800 ${0.86 * D}px system-ui, "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    const box = ctx.measureText('?')
    ctx.fillText('?', 0, (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2)
  } else if (pose.badge === 'read') {
    const active = live ? Math.min(2, Math.floor((cue * 3) / READ_LINES)) : -1
    const progress = live ? cue - Math.floor(cue) : 1
    ctx.lineWidth = 0.13 * D
    for (let i = 0; i < 3; i++) {
      const y = (i - 1) * 0.27 * D
      const span = (i === 2 ? 0.3 : 0.5) * D
      ctx.globalAlpha = pose.cueAlpha * (live && i !== active ? 0.5 : 1)
      ctx.beginPath()
      ctx.moveTo(-0.25 * D, y)
      ctx.lineTo(-0.25 * D + (i === active ? Math.max(0.05 * D, span * progress) : span), y)
      ctx.stroke()
    }
  } else if (pose.badge === 'edit') {
    const L = 0.66 * D
    const W = 0.22 * D
    const tip = 0.2 * D
    const poke = live ? 0.05 * D * cue : 0
    ctx.rotate(Math.PI * 0.75)
    ctx.translate(poke, 0)
    ctx.beginPath()
    ctx.moveTo(-L / 2, -W / 2)
    ctx.lineTo(L / 2 - tip, -W / 2)
    ctx.lineTo(L / 2, 0)
    ctx.lineTo(L / 2 - tip, W / 2)
    ctx.lineTo(-L / 2, W / 2)
    ctx.closePath()
    ctx.fill()
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
    const x = fx * S + form.face[0] * R + Math.sin(angle) * R * 0.76 * (1 + CROSS_SPREAD * pose.crossed)
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
      ctx.lineWidth = 0.25 * R * EYE_SIZE * 0.62
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
