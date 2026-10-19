export interface ArtifactIdentity {
  readonly sessionId: string | null
  readonly messageId: string
  readonly partIndex: number
  readonly toolCallId?: string
}

export function identityKey(id: ArtifactIdentity): string {
  return [id.sessionId ?? '', id.messageId, String(id.partIndex), id.toolCallId ?? ''].join('\u0000')
}

export function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return identityKey(a) === identityKey(b)
}

export type ArtifactForm = 'inline' | 'panel' | 'fullscreen' | 'pip'

export const ARTIFACT_FORMS: readonly ArtifactForm[] = ['inline', 'panel', 'fullscreen', 'pip']

export function isArtifactForm(value: unknown): value is ArtifactForm {
  return typeof value === 'string' && (ARTIFACT_FORMS as readonly string[]).includes(value)
}

export const INLINE_MAX_HEIGHT = 720
export const INLINE_MAX_HEIGHT_VH = 0.7
export const INLINE_MIN_HEIGHT = 120

export function inlineMaxHeight(viewportHeight: number): number {
  return Math.round(Math.min(viewportHeight * INLINE_MAX_HEIGHT_VH, INLINE_MAX_HEIGHT))
}

export function clampInlineHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return INLINE_MIN_HEIGHT
  return Math.max(INLINE_MIN_HEIGHT, Math.min(Math.round(height), inlineMaxHeight(viewportHeight)))
}

export function inlineOverflows(rawHeight: number, viewportHeight: number): boolean {
  return Number.isFinite(rawHeight) && rawHeight > inlineMaxHeight(viewportHeight) + 1
}

export interface FrameSize {
  width: number
  height: number
}

export const PIP_SIZE = { min: { width: 240, height: 180 }, max: { width: 720, height: 640 } } as const

export function clampFrameSize(size: FrameSize, bounds: { min: FrameSize; max: FrameSize }): FrameSize {
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(Math.round(Number.isFinite(value) ? value : min), max))
  return {
    width: clamp(size.width, bounds.min.width, bounds.max.width),
    height: clamp(size.height, bounds.min.height, bounds.max.height)
  }
}

export const PIP_VIEWPORT_MARGIN = 8

export interface FrameRect extends FrameSize {
  readonly x: number
  readonly y: number
}

export function clampFramePosition(rect: FrameRect, viewport: FrameSize): FrameRect {
  const maxX = Math.max(PIP_VIEWPORT_MARGIN, viewport.width - rect.width - PIP_VIEWPORT_MARGIN)
  const maxY = Math.max(PIP_VIEWPORT_MARGIN, viewport.height - rect.height - PIP_VIEWPORT_MARGIN)
  return {
    ...rect,
    x: Math.max(PIP_VIEWPORT_MARGIN, Math.min(Math.round(rect.x), Math.round(maxX))),
    y: Math.max(PIP_VIEWPORT_MARGIN, Math.min(Math.round(rect.y), Math.round(maxY)))
  }
}

export function defaultPipRect(viewport: FrameSize): FrameRect {
  const size = clampFrameSize({ width: 360, height: 300 }, PIP_SIZE)
  return clampFramePosition(
    { x: viewport.width - size.width - 16, y: viewport.height - size.height - 16, ...size },
    viewport
  )
}

export function moveFrame(rect: FrameRect, dx: number, dy: number, viewport: FrameSize): FrameRect {
  return clampFramePosition({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport)
}

export function resizeFrame(rect: FrameRect, dx: number, dy: number, viewport: FrameSize): FrameRect {
  const size = clampFrameSize({ width: rect.width + dx, height: rect.height + dy }, PIP_SIZE)
  return clampFramePosition({ x: rect.x, y: rect.y, ...size }, viewport)
}

const NUDGE_STEP = 16
const NUDGE_STEP_LARGE = 64

export function nudgeFrame(
  rect: FrameRect,
  key: string,
  modifiers: { alt: boolean; shift: boolean },
  viewport: FrameSize
): FrameRect | null {
  const step = modifiers.shift ? NUDGE_STEP_LARGE : NUDGE_STEP
  const dx = key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0
  const dy = key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : 0
  if (dx === 0 && dy === 0) return null
  return modifiers.alt ? moveFrame(rect, dx, dy, viewport) : resizeFrame(rect, dx, dy, viewport)
}

export const MAX_ACTIVE_FRAMES = 4

export interface FrameSlot {
  readonly key: string
  readonly generation?: number
  readonly visible: boolean
  readonly lastSeenAt: number
}

export function selectFrameEvictions(slots: readonly FrameSlot[], limit = MAX_ACTIVE_FRAMES): string[] {
  if (slots.length <= limit) return []
  const ranked = [...slots].sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? 1 : -1
    return a.lastSeenAt - b.lastSeenAt
  })
  return ranked.slice(0, slots.length - limit).map((slot) => slot.key)
}

export function framesToFreeFor(slots: readonly FrameSlot[], key: string, limit = MAX_ACTIVE_FRAMES): string[] {
  if (slots.some((slot) => slot.key === key)) return []
  if (slots.length < limit) return []
  return selectFrameEvictions(slots, Math.max(0, limit - 1))
}

export interface OwnerLike {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly active: boolean
  readonly generation?: number
}

export function ownerAllowsInteractive(owner: OwnerLike): boolean {
  return owner.active === true
}

export function ownerOwnsSession(owner: OwnerLike, sessionId: string | null): boolean {
  return !!owner.sessionId && !!sessionId && owner.sessionId === sessionId
}

export async function ownerScopedRead<T>(options: {
  expectedKey: string
  currentKey: () => string
  read: () => Promise<T>
}): Promise<{ ok: true; value: T } | { ok: false; reason: 'stale' | 'error' }> {
  if (options.currentKey() !== options.expectedKey) return { ok: false, reason: 'stale' }
  try {
    const value = await options.read()
    if (options.currentKey() !== options.expectedKey) return { ok: false, reason: 'stale' }
    return { ok: true, value }
  } catch {
    if (options.currentKey() !== options.expectedKey) return { ok: false, reason: 'stale' }
    return { ok: false, reason: 'error' }
  }
}

export const BRIDGE_MESSAGE_LIMIT_BYTES = 1024 * 1024
export const BRIDGE_MESSAGE_RATE = 50
export const BRIDGE_UI_MESSAGE_CHARS = 32_000
export const BRIDGE_CONTEXT_CHARS = 16_000
export const BRIDGE_SIZE_MIN = 40
export const BRIDGE_SIZE_MAX = 20_000

export type BridgeError = 'source' | 'generation' | 'shape' | 'size' | 'limit' | 'unsupported' | 'url'

export type BridgeAction =
  | { kind: 'ready' }
  | { kind: 'size-changed'; height: number }
  | { kind: 'request-display-mode'; form: ArtifactForm }
  | { kind: 'message'; text: string }
  | { kind: 'open-link'; url: string }
  | { kind: 'update-model-context'; text: string }
  | { kind: 'state-save'; text: string }
  | { kind: 'state-restore' }

export type BridgeDecode = { ok: true; action: BridgeAction } | { ok: false; error: BridgeError }

interface BridgeContext {
  readonly sourceOk: boolean
  readonly frameGeneration: number
  readonly displayModes?: readonly ArtifactForm[]
}

function textBytes(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}

function safeHttps(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function generationOf(raw: Record<string, unknown>): number | null {
  const value = raw.yanGeneration
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function decodeBridgeMessage(raw: unknown, ctx: BridgeContext): BridgeDecode {
  if (!ctx.sourceOk) return { ok: false, error: 'source' }
  const message = asObject(raw)
  if (!message) return { ok: false, error: 'shape' }

  const declaredGeneration = generationOf(message)
  if (declaredGeneration === null || declaredGeneration !== ctx.frameGeneration) return { ok: false, error: 'generation' }

  const method = typeof message.method === 'string' ? message.method : null
  const legacyType = typeof message.type === 'string' ? message.type : null
  const params = asObject(message.params) ?? message
  const modes = ctx.displayModes ?? ARTIFACT_FORMS

  if (method === 'tools/call' || method === 'resources/read' || method === 'ui/resource-teardown') {
    return { ok: false, error: 'unsupported' }
  }

  if (method === 'ui/initialize' || legacyType === 'ready') return { ok: true, action: { kind: 'ready' } }

  if (method === 'ui/notifications/size-changed' || legacyType === 'height') {
    const rawHeight = method ? params.height : message.h
    if (typeof rawHeight !== 'number' || !Number.isFinite(rawHeight)) return { ok: false, error: 'shape' }
    const height = Math.max(BRIDGE_SIZE_MIN, Math.min(BRIDGE_SIZE_MAX, Math.ceil(rawHeight)))
    return { ok: true, action: { kind: 'size-changed', height } }
  }

  if (method === 'ui/request-display-mode' || legacyType === 'displayMode') {
    const mode = method ? params.mode : message.mode
    if (!isArtifactForm(mode) || !modes.includes(mode)) return { ok: false, error: 'shape' }
    return { ok: true, action: { kind: 'request-display-mode', form: mode } }
  }

  if (method === 'ui/message') {
    const content = params.content
    const text = typeof content === 'string' ? content : typeof (asObject(content)?.text) === 'string' ? asObject(content)?.text : null
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'shape' }
    if (text.length > BRIDGE_UI_MESSAGE_CHARS) return { ok: false, error: 'limit' }
    return { ok: true, action: { kind: 'message', text: text.slice(0, BRIDGE_UI_MESSAGE_CHARS) } }
  }

  if (method === 'ui/open-link' || legacyType === 'open') {
    const candidate = method ? params.url : message.url
    const url = safeHttps(candidate)
    return url ? { ok: true, action: { kind: 'open-link', url } } : { ok: false, error: 'url' }
  }

  if (method === 'ui/update-model-context') {
    const content = params.content
    const text = typeof content === 'string' ? content : typeof (asObject(content)?.text) === 'string' ? asObject(content)?.text : null
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'shape' }
    if (text.length > BRIDGE_CONTEXT_CHARS) return { ok: false, error: 'limit' }
    return { ok: true, action: { kind: 'update-model-context', text: text.slice(0, BRIDGE_CONTEXT_CHARS) } }
  }

  if (method === 'x-inkstone/state-save' || legacyType === 'state') {
    const state = method ? params.state : message.text
    if (typeof state !== 'string') return { ok: false, error: 'shape' }
    if (textBytes(state) > 64 * 1024) return { ok: false, error: 'size' }
    return { ok: true, action: { kind: 'state-save', text: state } }
  }

  if (method === 'x-inkstone/state-restore') return { ok: true, action: { kind: 'state-restore' } }

  return { ok: false, error: 'unsupported' }
}

export function bridgeMessageWithinLimit(raw: string): boolean {
  return textBytes(raw) <= BRIDGE_MESSAGE_LIMIT_BYTES
}

export class BridgeRateLimiter {
  private readonly stamps: number[] = []

  constructor(
    private readonly limit = BRIDGE_MESSAGE_RATE,
    private readonly windowMs = 1000
  ) {}

  allow(now: number): boolean {
    while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift()
    if (this.stamps.length >= this.limit) return false
    this.stamps.push(now)
    return true
  }

  reset(): void {
    this.stamps.length = 0
  }
}

export type PreviewKind = 'text' | 'image' | 'office' | 'html' | 'binary'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|ico)$/i
const OFFICE_EXT = /\.(docx|xlsx|pptx|pdf)$/i
const HTML_EXT = /\.html?$/i
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|bash|ps1|sql|log|diff|patch|svg)$/i

export function previewKindOf(nameOrPath: string): PreviewKind {
  if (HTML_EXT.test(nameOrPath)) return 'html'
  if (IMAGE_EXT.test(nameOrPath)) return 'image'
  if (OFFICE_EXT.test(nameOrPath)) return 'office'
  if (TEXT_EXT.test(nameOrPath)) return 'text'
  return 'binary'
}

export function previewNeedsOfficeIpc(kind: PreviewKind): boolean {
  return kind === 'office'
}
