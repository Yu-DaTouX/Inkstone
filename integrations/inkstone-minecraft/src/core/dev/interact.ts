import { CompanionError, companionRequest, type CompanionEndpoint } from './companion.ts'

export type CompanionSender = (path: string, body: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

export const USER_CONTROL_ERROR = 'user_control'

export function companionSender(endpoint: CompanionEndpoint): CompanionSender {
  return (path, body, timeoutMs) => companionRequest(endpoint, path, body, timeoutMs)
}

export function isUserControlError(error: unknown): boolean {
  if (error instanceof CompanionError) return error.status === 423 || error.message === USER_CONTROL_ERROR
  return error instanceof Error && error.message === USER_CONTROL_ERROR
}

export type BlockFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'
export type InputHand = 'main' | 'off'
export type InputAction = 'attack' | 'use' | 'look' | 'move' | 'hotbar' | 'key'
export type InputTarget = { block: [number, number, number]; face?: BlockFace } | { entity: string }

export interface InputRequest {
  action: InputAction
  target?: InputTarget
  hand?: InputHand
  holdTicks?: number
  yaw?: number
  pitch?: number
  at?: [number, number, number]
  forward?: number
  strafe?: number
  jump?: boolean
  sneak?: boolean
  sprint?: boolean
  ticks?: number
  slot?: number
  key?: string
}

export interface HitResult {
  type: 'block' | 'entity' | 'miss'
  pos?: [number, number, number]
  entity?: string
}

export interface InputReply {
  ok: boolean
  hit?: HitResult
  screen: string | null
}

export interface CompanionItem {
  id: string
  count: number
  components?: string
}

export interface UiSlot {
  index: number
  x: number
  y: number
  cx?: number
  cy?: number
  container: 'menu' | 'player'
  role?: 'hotbar' | 'inventory' | 'armor' | 'offhand' | 'other' | 'menu'
  item: CompanionItem | null
}

export type UiWidgetType = 'button' | 'edit' | 'checkbox' | 'slider' | 'other'
export type UiScreenKind = 'container' | 'chat' | 'sign' | 'book' | 'anvil' | 'creative' | 'other'

export interface UiWidget {
  id: number
  type: UiWidgetType
  label: string
  value?: string
  focused?: boolean
  active: boolean
  x: number
  y: number
  w: number
  h: number
}

export interface UiScreen {
  class: string
  title: string
  kind: UiScreenKind
  menu?: string
  slots: UiSlot[]
  widgets: UiWidget[]
  carried?: CompanionItem | null
  guiScale?: number
  hover?: { x: number; y: number }
}

export interface UiReply {
  screen: UiScreen | null
  tooltip?: string[]
}

export type UiRequest =
  | { action: 'read' }
  | { action: 'click'; slot?: number; button?: 'left' | 'right' | 'middle'; shift?: boolean; widget?: number; x?: number; y?: number }
  | { action: 'hover'; slot?: number; x?: number; y?: number }
  | { action: 'type'; widget?: number; text: string; replace?: boolean; submit?: boolean }
  | { action: 'key'; key: string }
  | { action: 'close' }
  | { action: 'open'; screen: 'inventory' | 'chat'; text?: string }

export type ChatKind = 'chat' | 'system' | 'actionbar' | 'title' | 'subtitle'

export interface ChatMessage {
  seq: number
  time: number
  kind: ChatKind
  text: string
}

export interface ChatRequest {
  since?: number
  limit?: number
}

export interface ChatReply {
  latest: number
  messages: ChatMessage[]
}

export type ScriptOp = 'command' | 'input' | 'ui' | 'wait' | 'screenshot' | 'player' | 'chat' | 'perf'

export interface ScriptStep {
  op: ScriptOp
  [key: string]: unknown
}

export interface ScriptRequest {
  steps: ScriptStep[]
  timeoutTicks?: number
}

export interface ScriptStepResult {
  index: number
  op: string
  tick: number
  timeMs: number
  ok: boolean
  result?: unknown
  error?: string
  image: Buffer | null
}

export interface ScriptReply {
  results: ScriptStepResult[]
}

export interface PerfReply {
  fps: number
  mspt: number
  tps: number
  memory: { used: number; max: number }
  entities: number
  chunks: number
}

export type ScreenshotGrid = boolean | { step?: number }

export interface ScreenshotRequest {
  hideHud?: boolean
  crop?: [number, number, number, number]
  grid?: ScreenshotGrid
}

export const GRID_STEP_DEFAULT = 50
const GRID_STEP_MIN = 4
const GRID_STEP_MAX = 400

export function gridRequest(value: unknown): ScreenshotGrid | undefined {
  if (value === true) return true
  if (value === undefined || value === null || value === false) return undefined
  if (typeof value === 'number') return Number.isFinite(value) && value >= GRID_STEP_MIN ? { step: Math.round(Math.min(GRID_STEP_MAX, value)) } : undefined
  if (typeof value === 'object') {
    const step = num((value as Json).step)
    return step !== undefined && step >= GRID_STEP_MIN ? { step: Math.round(Math.min(GRID_STEP_MAX, step)) } : true
  }
  return undefined
}

export type HighlightRequest =
  | { action: 'entity'; selector?: string; uuid?: string; color?: string; seconds?: number }
  | { action: 'block'; pos: [number, number, number]; color?: string; seconds?: number }
  | { action: 'clear' }

export interface HighlightReply {
  id: string | null
  until: number | null
  cleared?: number
}

export type WaitUntil = 'in_world' | 'screen' | 'no_screen' | 'chat' | 'ticks' | 'entity' | 'player'

export const WAIT_TIMEOUT_DEFAULT = 30_000

export interface WaitRequest {
  until: WaitUntil
  screen?: string
  match?: string
  since?: number
  ticks?: number
  selector?: string
  field?: string
  equals?: number | boolean | string
  lt?: number
  gt?: number
  timeoutMs?: number
  pollTicks?: number
}

export interface WaitReply {
  ok: boolean
  waitedMs: number
  tick: number
  reason?: string
  detail?: string
}

export interface CompanionEnv {
  world: string | null
  version: string
  difficulty: string
  gamemode: string
  lang: string
  pos: [number, number, number] | null
  dimension: string
  paused: boolean
}

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function triple(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const parsed = value.map(num)
  return parsed.every((item) => item !== undefined) ? (parsed as [number, number, number]) : undefined
}

function formatEntity(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const raw = record(value)
  const parts = [str(raw.type) ?? str(raw.id), str(raw.name) ?? str(raw.customName), str(raw.uuid)].filter(Boolean)
  return parts.length ? parts.join(' ') : undefined
}

function parseHit(value: unknown): HitResult | undefined {
  const raw = record(value)
  const type = raw.type === 'block' || raw.type === 'entity' ? raw.type : raw.type === 'miss' ? 'miss' : undefined
  if (!type) return undefined
  return { type, pos: triple(raw.pos), entity: type === 'entity' ? formatEntity(raw.entity) : undefined }
}

function parseItem(value: unknown): CompanionItem | null {
  if (typeof value === 'string' && value) return { id: value, count: 1 }
  const raw = record(value)
  const id = str(raw.id)
  if (!id || id === 'minecraft:air') return null
  const components = raw.components
  return {
    id,
    count: num(raw.count) ?? 1,
    components: typeof components === 'string' ? components : components && typeof components === 'object' ? JSON.stringify(components) : undefined
  }
}

function parseSlots(value: unknown): UiSlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const raw = record(entry)
    const index = num(raw.index)
    if (index === undefined) return []
    return [
      {
        index,
        x: num(raw.x) ?? 0,
        y: num(raw.y) ?? 0,
        cx: num(raw.cx),
        cy: num(raw.cy),
        container: raw.container === 'player' ? 'player' : 'menu',
        role: raw.role === 'hotbar' || raw.role === 'inventory' || raw.role === 'armor' || raw.role === 'offhand' || raw.role === 'other' || raw.role === 'menu' ? raw.role : undefined,
        item: parseItem(raw.item)
      }
    ]
  })
}

function parseWidgets(value: unknown): UiWidget[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const raw = record(entry)
    const id = num(raw.id)
    if (id === undefined) return []
    const type = raw.type
    return [
      {
        id,
        type: type === 'button' || type === 'edit' || type === 'checkbox' || type === 'slider' ? type : 'other',
        label: str(raw.label) ?? '',
        value: str(raw.value),
        focused: bool(raw.focused),
        active: raw.active !== false,
        x: num(raw.x) ?? 0,
        y: num(raw.y) ?? 0,
        w: num(raw.w) ?? 0,
        h: num(raw.h) ?? 0
      }
    ]
  })
}

export function parseScreen(value: unknown): UiScreen | null {
  const raw = record(value)
  const className = str(raw.class)
  if (!className) return null
  const kind = raw.kind
  return {
    class: className,
    title: str(raw.title) ?? '',
    kind: kind === 'container' || kind === 'chat' || kind === 'sign' || kind === 'book' || kind === 'anvil' || kind === 'creative' ? kind : 'other',
    menu: str(raw.menu),
    slots: parseSlots(raw.slots),
    widgets: parseWidgets(raw.widgets),
    carried: raw.carried === undefined ? undefined : parseItem(raw.carried),
    guiScale: num(raw.guiScale),
    hover: raw.hover === undefined ? undefined : { x: num(record(raw.hover).x) ?? 0, y: num(record(raw.hover).y) ?? 0 }
  }
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const raw = record(entry)
    const text = str(raw.text)
    if (text === undefined) return []
    const kind = raw.kind
    return [
      {
        seq: num(raw.seq) ?? 0,
        time: num(raw.time) ?? 0,
        kind: kind === 'system' || kind === 'actionbar' || kind === 'title' || kind === 'subtitle' ? kind : 'chat',
        text
      }
    ]
  })
}

export function scriptTimeout(request: ScriptRequest): number {
  return 30_000 + (request.timeoutTicks ?? 200) * 100
}

export async function sendInput(send: CompanionSender, request: InputRequest, timeoutMs = 30_000): Promise<InputReply> {
  const raw = record(await send('/input', { ...request }, timeoutMs))
  return { ok: raw.ok !== false, hit: parseHit(raw.hit), screen: str(raw.screen) ?? null }
}

export async function sendUi(send: CompanionSender, request: UiRequest, timeoutMs = 30_000): Promise<UiReply> {
  const raw = record(await send('/ui', { ...request }, timeoutMs))
  const tooltip = Array.isArray(raw.tooltip) ? raw.tooltip.filter((line): line is string => typeof line === 'string') : undefined
  return tooltip ? { screen: parseScreen(raw.screen), tooltip } : { screen: parseScreen(raw.screen) }
}

export async function sendChat(send: CompanionSender, request: ChatRequest = {}, timeoutMs = 15_000): Promise<ChatReply> {
  const body: Record<string, unknown> = {}
  if (request.since !== undefined) body.since = request.since
  if (request.limit !== undefined) body.limit = request.limit
  const raw = record(await send('/chat', body, timeoutMs))
  return { latest: num(raw.latest) ?? 0, messages: parseMessages(raw.messages) }
}

export async function sendScript(send: CompanionSender, request: ScriptRequest, timeoutMs = scriptTimeout(request)): Promise<ScriptReply> {
  const body: Record<string, unknown> = { steps: request.steps }
  if (request.timeoutTicks !== undefined) body.timeoutTicks = request.timeoutTicks
  const raw = record(await send('/script', body, timeoutMs))
  const results = Array.isArray(raw.results) ? raw.results : []
  return {
    results: results.map((entry, index) => {
      const step = record(entry)
      const image = str(step.image)
      return {
        index: num(step.index) ?? index,
        op: str(step.op) ?? '',
        tick: num(step.tick) ?? 0,
        timeMs: num(step.timeMs) ?? 0,
        ok: step.ok !== false && !str(step.error),
        result: step.result,
        error: str(step.error),
        image: image ? Buffer.from(image, 'base64') : null
      }
    })
  }
}

export async function sendHighlight(send: CompanionSender, request: HighlightRequest, timeoutMs = 15_000): Promise<HighlightReply> {
  const raw = record(await send('/highlight', { ...request }, timeoutMs))
  return { id: str(raw.id) ?? null, until: num(raw.until) ?? null, cleared: num(raw.cleared) }
}

export function waitTimeout(request: WaitRequest): number {
  return (request.timeoutMs ?? WAIT_TIMEOUT_DEFAULT) + 15_000
}

export async function sendWait(send: CompanionSender, request: WaitRequest, timeoutMs = waitTimeout(request)): Promise<WaitReply> {
  const raw = record(await send('/wait', { ...request }, timeoutMs))
  return { ok: raw.ok === true, waitedMs: num(raw.waitedMs) ?? 0, tick: num(raw.tick) ?? 0, reason: str(raw.reason), detail: str(raw.detail) }
}

export async function sendPerf(send: CompanionSender, timeoutMs = 15_000): Promise<PerfReply> {
  const raw = record(await send('/perf', {}, timeoutMs))
  const memory = record(raw.memory)
  return {
    fps: num(raw.fps) ?? 0,
    mspt: num(raw.mspt) ?? 0,
    tps: num(raw.tps) ?? 0,
    memory: { used: num(memory.used) ?? 0, max: num(memory.max) ?? 0 },
    entities: num(raw.entities) ?? 0,
    chunks: num(raw.chunks) ?? 0
  }
}

export async function sendStatus(send: CompanionSender, timeoutMs = 10_000): Promise<Json> {
  return record(await send('/status', {}, timeoutMs))
}

export function parseCompanionEnv(value: unknown): CompanionEnv | null {
  const raw = record(value)
  const version = str(raw.version)
  if (!version) return null
  return {
    world: str(raw.world) ?? null,
    version,
    difficulty: str(raw.difficulty) ?? '',
    gamemode: str(raw.gamemode) ?? '',
    lang: str(raw.lang) ?? '',
    pos: triple(raw.pos) ?? null,
    dimension: str(raw.dimension) ?? '',
    paused: raw.paused === true
  }
}
