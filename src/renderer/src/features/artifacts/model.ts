/**
 * 成果视图（WP-32）的纯逻辑。
 *
 * 这里只放**不碰 DOM、不碰 React、不碰 store** 的判定：身份、形态、活跃框架
 * 上限、尺寸钳制、桥消息解码与限流、会话归属核对、预览能力分类。
 * 组件（`ArtifactFrame` / `VisualFence` / `PreviewPane`）只调用这些函数，
 * 因此行为可以在 Node 里直接测（`scripts/test-v3-artifacts.mjs`）。
 *
 * 安全立场（与设计规范 §11 一致）：
 *   · 内容身份 = (sessionId, messageId, partIndex[, toolCallId])；
 *   · 形态切换只改样式/位置，不重建 iframe；
 *   · 桥只接受握手后的实例消息，按 schema 校验、限速、限体积；
 *   · 普通 HTML 小部件走现有 `inkstone-html` 隔离协议；这是 `yan-widget` 的子集，
 *     **不是** MCP Apps 宿主，`tools/call` / `resources/read` 一律拒绝。
 */

/* ─────────────────────────────────────────────── 身份 */

export interface ArtifactIdentity {
  readonly sessionId: string | null
  readonly messageId: string
  readonly partIndex: number
  /** 只有 MCP App / 工具产物才有；普通 markdown 图块没有。 */
  readonly toolCallId?: string
}

/** 稳定身份：内容改写、重排都不改变它，因此帧与交互状态能跨版本保留。 */
export function identityKey(id: ArtifactIdentity): string {
  return [id.sessionId ?? '', id.messageId, String(id.partIndex), id.toolCallId ?? ''].join('\u0000')
}

export function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return identityKey(a) === identityKey(b)
}

/* ─────────────────────────────────────────────── 形态 */

export type ArtifactForm = 'inline' | 'panel' | 'fullscreen' | 'pip'

export const ARTIFACT_FORMS: readonly ArtifactForm[] = ['inline', 'panel', 'fullscreen', 'pip']

export function isArtifactForm(value: unknown): value is ArtifactForm {
  return typeof value === 'string' && (ARTIFACT_FORMS as readonly string[]).includes(value)
}

/** 需求 §11.2：内联高度上限 min(70vh, 720px)，不嵌套纵向滚动。 */
export const INLINE_MAX_HEIGHT = 720
export const INLINE_MAX_HEIGHT_VH = 0.7
export const INLINE_MIN_HEIGHT = 120

/** 内联高度上限：min(70vh, 720px)。 */
export function inlineMaxHeight(viewportHeight: number): number {
  return Math.round(Math.min(viewportHeight * INLINE_MAX_HEIGHT_VH, INLINE_MAX_HEIGHT))
}

export function clampInlineHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return INLINE_MIN_HEIGHT
  return Math.max(INLINE_MIN_HEIGHT, Math.min(Math.round(height), inlineMaxHeight(viewportHeight)))
}

/** 页面回报的自然高度超过内联上限 → 底部渐隐并显示「展开全屏」。 */
export function inlineOverflows(rawHeight: number, viewportHeight: number): boolean {
  return Number.isFinite(rawHeight) && rawHeight > inlineMaxHeight(viewportHeight) + 1
}

export interface FrameSize {
  width: number
  height: number
}

/** 画中画 / 面板的尺寸钳制：太小看不清，太大盖住输入区。 */
export const PIP_SIZE = { min: { width: 240, height: 180 }, max: { width: 720, height: 640 } } as const

export function clampFrameSize(size: FrameSize, bounds: { min: FrameSize; max: FrameSize }): FrameSize {
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(Math.round(Number.isFinite(value) ? value : min), max))
  return {
    width: clamp(size.width, bounds.min.width, bounds.max.width),
    height: clamp(size.height, bounds.min.height, bounds.max.height)
  }
}

/* ─────────────────────────────────────────────── 画中画几何 */

/** 画中画在视口内至少保留的边距，避免拖出屏后抓不回来。 */
export const PIP_VIEWPORT_MARGIN = 8

/** 窗口坐标系里的框架矩形（画中画用）。 */
export interface FrameRect extends FrameSize {
  readonly x: number
  readonly y: number
}

/** 把整块框架夹进视口（留出边距）。 */
export function clampFramePosition(rect: FrameRect, viewport: FrameSize): FrameRect {
  const maxX = Math.max(PIP_VIEWPORT_MARGIN, viewport.width - rect.width - PIP_VIEWPORT_MARGIN)
  const maxY = Math.max(PIP_VIEWPORT_MARGIN, viewport.height - rect.height - PIP_VIEWPORT_MARGIN)
  return {
    ...rect,
    x: Math.max(PIP_VIEWPORT_MARGIN, Math.min(Math.round(rect.x), Math.round(maxX))),
    y: Math.max(PIP_VIEWPORT_MARGIN, Math.min(Math.round(rect.y), Math.round(maxY)))
  }
}

/** 缺省贴在窗口右下角。 */
export function defaultPipRect(viewport: FrameSize): FrameRect {
  const size = clampFrameSize({ width: 360, height: 300 }, PIP_SIZE)
  return clampFramePosition(
    { x: viewport.width - size.width - 16, y: viewport.height - size.height - 16, ...size },
    viewport
  )
}

/** 拖动：位移后夹进视口。 */
export function moveFrame(rect: FrameRect, dx: number, dy: number, viewport: FrameSize): FrameRect {
  return clampFramePosition({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport)
}

/** 缩放：从右下角加宽加高，先按 PIP_SIZE 钳制，再夹进视口。 */
export function resizeFrame(rect: FrameRect, dx: number, dy: number, viewport: FrameSize): FrameRect {
  const size = clampFrameSize({ width: rect.width + dx, height: rect.height + dy }, PIP_SIZE)
  return clampFramePosition({ x: rect.x, y: rect.y, ...size }, viewport)
}

/* ─────────────────────────────────────────────── 活跃框架上限与离屏冻结 */

/** 需求 §11.4 / §19：最多同时保持 4 个活跃框架。 */
export const MAX_ACTIVE_FRAMES = 4

export interface FrameSlot {
  readonly key: string
  readonly generation?: number
  /** 在视口内、且形态需要渲染。 */
  readonly visible: boolean
  /** 最近一次可见时间（毫秒）。离屏优先冻结，再按时间淘汰。 */
  readonly lastSeenAt: number
}

/**
 * 选出需要让位的框架键。
 *
 * 优先淘汰：离屏且最久未见过；都在屏内时，先淘汰超过上限的、最久未见的。
 * 返回空数组表示当前数量在上限内，不需要淘汰。
 */
export function selectFrameEvictions(slots: readonly FrameSlot[], limit = MAX_ACTIVE_FRAMES): string[] {
  if (slots.length <= limit) return []
  const ranked = [...slots].sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? 1 : -1
    return a.lastSeenAt - b.lastSeenAt
  })
  return ranked.slice(0, slots.length - limit).map((slot) => slot.key)
}

/** 是否需要为 `key` 腾位置（它本身已存在就返回空）。 */
export function framesToFreeFor(slots: readonly FrameSlot[], key: string, limit = MAX_ACTIVE_FRAMES): string[] {
  if (slots.some((slot) => slot.key === key)) return []
  if (slots.length < limit) return []
  /* 要接纳一个新键，必须让现有数量降到 limit-1。 */
  return selectFrameEvictions(slots, Math.max(0, limit - 1))
}

/* ─────────────────────────────────────────────── 会话归属 */

/**
 * 与 R0 `workbench/types.ts` 的 `WorkspaceOwner` 结构一致。
 * 为什么在这里再声明一份：R5 的纯逻辑不能依赖 React 目录即可测试；
 * 组件从 R0 类型导入，模型用最小结构接收（duck typing）。
 */
export interface OwnerLike {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly active: boolean
  readonly generation?: number
}

/** `active=false`：可以只读展示，不得新建/执行 PTY 或原生浏览器动作。 */
export function ownerAllowsInteractive(owner: OwnerLike): boolean {
  return owner.active === true
}

/** 成果属于哪条会话：用真实 owner 的 sessionId 核对，缺失时明确不匹配。 */
export function ownerOwnsSession(owner: OwnerLike, sessionId: string | null): boolean {
  return !!owner.sessionId && !!sessionId && owner.sessionId === sessionId
}

/**
 * 归属核对的一次异步闸门：读取返回后 owner 已切走就别把旧数据写进界面。
 * 这是「异步归属核对」的最小实现，不引入新 IPC 或新授权。
 */
export async function ownerScopedRead<T>(options: {
  expectedKey: string
  currentKey: () => string
  read: () => Promise<T>
}): Promise<{ ok: true; value: T } | { ok: false; reason: 'stale' | 'error' }> {
  /* 读取前后各核一次：开始前 owner 已经切走就不发起；返回后切走就丢弃结果。 */
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

/* ─────────────────────────────────────────────── 安全桥（yan-widget 子集） */

/** 单条消息 ≤ 1 MiB。 */
export const BRIDGE_MESSAGE_LIMIT_BYTES = 1024 * 1024
/** ≤ 50 条/秒。 */
export const BRIDGE_MESSAGE_RATE = 50
/** `ui/message` 只填入输入框，长度上限见需求 §12.5。 */
export const BRIDGE_UI_MESSAGE_CHARS = 32_000
/** `update-model-context` 进上下文提示，按字符近似 token 上限。 */
export const BRIDGE_CONTEXT_CHARS = 16_000
/** 页面回报的高度范围。 */
export const BRIDGE_SIZE_MIN = 40
export const BRIDGE_SIZE_MAX = 20_000

export type BridgeError = 'source' | 'generation' | 'shape' | 'size' | 'limit' | 'unsupported' | 'url'

export type BridgeAction =
  /** `ui/initialize`：页面请求握手；此后宿主才下发主题与端口。 */
  | { kind: 'ready' }
  /** `ui/notifications/size-changed`。 */
  | { kind: 'size-changed'; height: number }
  /** `ui/request-display-mode`。 */
  | { kind: 'request-display-mode'; form: ArtifactForm }
  /** `ui/message`：只填入输入框，绝不自动发送。 */
  | { kind: 'message'; text: string }
  /** `ui/open-link`：只允许 https，由宿主二次确认。 */
  | { kind: 'open-link'; url: string }
  /** `ui/update-model-context`：作为输入框上方的一行提示。 */
  | { kind: 'update-model-context'; text: string }
  /** 砚扩展：页面主动请求保存交互状态。 */
  | { kind: 'state-save'; text: string }
  /** 砚扩展：页面请求恢复上一次保存的状态。 */
  | { kind: 'state-restore' }

export type BridgeDecode = { ok: true; action: BridgeAction } | { ok: false; error: BridgeError }

interface BridgeContext {
  /** `event.source === iframe.contentWindow` 的结果；宿主侧判定后传入。 */
  readonly sourceOk: boolean
  /** 宿主当前帧实例代号；页面回报的代号必须一致。 */
  readonly frameGeneration: number
  /** 允许的形态集合（缺省全部）。 */
  readonly displayModes?: readonly ArtifactForm[]
}

function textBytes(value: string): number {
  /* 与主进程 `Buffer.byteLength(..., 'utf8')` 近似；纯函数里用 UTF-8 字节数。 */
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

/**
 * 解码一条来自沙箱 iframe 的消息。
 *
 * 同时兼容两种写法：
 *   · `{ method, params }`（MCP Apps 子集 / `yan-widget` 桥 v2 的对外形状）
 *   · `{ yanWidget: 1, type, ... }`（现有 v1 小部件回报）
 * 只放行白名单动作；`tools/call`、`resources/read`、任意外链一律拒绝。
 */
export function decodeBridgeMessage(raw: unknown, ctx: BridgeContext): BridgeDecode {
  if (!ctx.sourceOk) return { ok: false, error: 'source' }
  const message = asObject(raw)
  if (!message) return { ok: false, error: 'shape' }

  const declaredGeneration = generationOf(message)
  /* 握手之后页面必须带上实例代号；缺失视为旧版/伪造，拒绝。 */
  if (declaredGeneration === null || declaredGeneration !== ctx.frameGeneration) return { ok: false, error: 'generation' }

  const method = typeof message.method === 'string' ? message.method : null
  const legacyType = typeof message.type === 'string' ? message.type : null
  const params = asObject(message.params) ?? message
  const modes = ctx.displayModes ?? ARTIFACT_FORMS

  /* MCP Apps 的工具/资源调用不在本任务范围：明确拒绝，不假装支持。 */
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

/** 解码前的体积闸门：超限直接丢弃，不进 JSON 之外的任何处理。 */
export function bridgeMessageWithinLimit(raw: string): boolean {
  return textBytes(raw) <= BRIDGE_MESSAGE_LIMIT_BYTES
}

/** 固定窗口限速：超过 50 条/秒就先节流。 */
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

/* ─────────────────────────────────────────────── 预览能力分类 */

export type PreviewKind = 'text' | 'image' | 'office' | 'html' | 'binary'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|ico)$/i
const OFFICE_EXT = /\.(docx|xlsx|pptx|pdf)$/i
const HTML_EXT = /\.html?$/i
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|sh|bash|ps1|sql|log|diff|patch|svg)$/i

/**
 * 预览走哪条能力。只按名字判断，真正的越界/大小校验仍在主进程 IPC 里。
 * 非文本一律不给内容（图片另走受控文件地址），未知按二进制处理。
 */
export function previewKindOf(nameOrPath: string): PreviewKind {
  if (HTML_EXT.test(nameOrPath)) return 'html'
  if (IMAGE_EXT.test(nameOrPath)) return 'image'
  if (OFFICE_EXT.test(nameOrPath)) return 'office'
  if (TEXT_EXT.test(nameOrPath)) return 'text'
  return 'binary'
}

/** 该能力是否可以用现有 IPC 授权读到正文/提取。 */
export function previewNeedsOfficeIpc(kind: PreviewKind): boolean {
  return kind === 'office'
}
