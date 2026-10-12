/**
 * 生图适配层：`yan image generate` 宿主命令背后的各家服务。
 *
 * 通道：ChatGPT 订阅（codex）、OpenAI API、OpenAI 兼容端点、Google Gemini、火山方舟（豆包 Seedream）、
 * 本机 SD WebUI / ComfyUI，以及测试用的 mock。provider=auto 时按 AUTO_ORDER 选第一个可用的，
 * 不会在失败后静默换通道。凭证读取在 image-credentials.ts，本机服务探测在 local-models.ts。
 */
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AssistantArtifact, ImageGenerationStage } from '../shared/ipc'
import type { LocalModelServer } from '../shared/custom-provider'
import { ArtifactStore } from './artifacts'
import { hostImageCredentials, type ImageCredentialSource } from './image-credentials'
import { detectLocalImageService, detectLocalModelServers, fetchComfyWorkflow, listComfyWorkflows, type ComfyWorkflowEntry } from './local-models'
import { ComfyLaunchError, ensureComfyRunning, findLaunchableComfy, holdManagedComfy } from './comfy-launcher'
import { applyRequest, toApiPrompt, usesApiNodes, workflowNodeTypes, WorkflowError, type ApiPrompt, type ObjectInfoEntry, type UiWorkflow } from './comfy-workflow'

export const IMAGE_PROVIDERS = ['auto', 'codex', 'openai', 'compatible', 'google', 'doubao', 'local', 'mock'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]
export type ResolvedImageProvider = Exclude<ImageProvider, 'auto'> | 'unavailable'

/** auto 的选择顺序：已登录的订阅 → 显式配置的兼容端点 → 各家 API key → 本机服务 */
const AUTO_ORDER = ['codex', 'compatible', 'openai', 'google', 'doubao', 'local'] as const

export interface ImageGenerationRequest {
  prompt: string
  provider?: ImageProvider
  model?: string
  size?: string
  quality?: string
  background?: string
  format?: 'png' | 'jpeg' | 'webp'
  mode?: 'generate' | 'edit'
  sourcePaths?: string[]
  description?: string
}

export interface ImageGenerationResult {
  provider: Exclude<ImageProvider, 'auto'>
  model: string
  artifact: AssistantArtifact
  revisedPrompt?: string
}

export type ImageProgressReporter = (stage: ImageGenerationStage, detail?: string) => void

/** 各通道当前是否可用（只看凭证与本机服务，不发计费请求） */
export interface ImageAvailability {
  codex: boolean
  openai: boolean
  compatible: boolean
  google: boolean
  doubao: boolean
  local: LocalModelServer | null
  /** 本机没有在运行的生图服务、但有能由砚启动的 ComfyUI 安装目录时，出图前按需拉起 */
  localLaunch?: string | null
}

export function isImageProvider(value: unknown): value is ImageProvider {
  return typeof value === 'string' && (IMAGE_PROVIDERS as readonly string[]).includes(value)
}

export async function detectImageProviders(
  credentials: ImageCredentialSource = hostImageCredentials,
  detectLocal: () => Promise<LocalModelServer | null> = detectLocalImageService,
  findLaunch: () => Promise<string | null> = findLaunchableComfy
): Promise<ImageAvailability> {
  const [codex, openai, google, doubao, local] = await Promise.all([
    credentials.hasCodex(),
    credentials.secret('openai'),
    credentials.secret('google'),
    credentials.secret('doubao'),
    detectLocal()
  ])
  return {
    codex,
    openai: !!openai,
    compatible: !!process.env.YAN_IMAGE_API_BASE?.trim() && !!process.env.YAN_IMAGE_API_KEY?.trim(),
    google: !!google,
    doubao: !!doubao,
    local,
    localLaunch: local ? null : await findLaunch().catch(() => null)
  }
}

/** 请求里的 provider 优先；没写或写 auto 时看 YAN_IMAGE_PROVIDER，仍是 auto 就按顺序挑 */
export function resolveImageProvider(requested: ImageProvider | undefined, available: ImageAvailability): ResolvedImageProvider {
  const configured = process.env.YAN_IMAGE_PROVIDER?.trim()
  const value = requested && requested !== 'auto' ? requested : isImageProvider(configured) ? configured : 'auto'
  if (value !== 'auto') return value
  for (const provider of AUTO_ORDER) {
    if (provider === 'local' ? available.local || available.localLaunch : available[provider]) return provider
  }
  return 'unavailable'
}

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

/** OpenAI 与 ChatGPT（Codex）通道的默认生图模型：GPT Image 2.5 的快速档（另一档是 gpt-image-2.5-sunburst） */
const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare'

/** 没指定模型时各通道的默认值（可用环境变量改，免得服务商改名后要发版） */
export function defaultImageModel(provider: ResolvedImageProvider, available?: ImageAvailability): string {
  switch (provider) {
    // Google 与豆包实际请求前会按服务商的模型列表挑最新一档（见 latestGoogleImageModel / latestSeedreamModel），这里是列表拿不到时的兜底
    case 'google':
      return envOr('YAN_IMAGE_GOOGLE_MODEL', 'gemini-3.1-flash-image')
    case 'doubao':
      return envOr('YAN_IMAGE_DOUBAO_MODEL', 'doubao-seedream-5-0-flash-260915')
    case 'local':
      return available?.local?.models[0] ?? 'local'
    case 'mock':
      return 'yan-mock-svg'
    case 'unavailable':
      return ''
    case 'compatible':
      // 兼容端点多是中转服务，新模型上架常滞后，默认用上一代
      return envOr('YAN_IMAGE_COMPATIBLE_MODEL', 'gpt-image-2')
    default:
      return envOr('YAN_IMAGE_OPENAI_MODEL', OPENAI_IMAGE_MODEL)
  }
}

/** 确认框里显示的请求去向；codex 与本机回环服务不弹确认 */
export function imageProviderEndpoint(provider: ResolvedImageProvider, available?: ImageAvailability): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'compatible':
      return process.env.YAN_IMAGE_API_BASE?.trim() ?? ''
    case 'google':
      return envOr('YAN_IMAGE_GOOGLE_BASE', GOOGLE_BASE)
    case 'doubao':
      return envOr('YAN_IMAGE_DOUBAO_BASE', DOUBAO_BASE)
    case 'local':
      // 按需启动的 ComfyUI 只监听本机回环
      return available?.local?.baseUrl ?? (available?.localLaunch ? 'http://127.0.0.1' : '')
    case 'codex':
      return 'https://chatgpt.com/backend-api/codex'
    default:
      return ''
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** 会把提示词发到第三方并可能计费的通道，发送前要用户确认 */
export function imageProviderNeedsConfirmation(provider: ResolvedImageProvider, available?: ImageAvailability): boolean {
  if (provider === 'openai' || provider === 'compatible' || provider === 'google' || provider === 'doubao') return true
  return provider === 'local' && !isLoopback(imageProviderEndpoint(provider, available))
}

/* ------------------------------------------------------------ 小工具 */

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function formatOf(value: unknown): 'png' | 'jpeg' | 'webp' {
  const v = String(value ?? 'png').toLowerCase()
  return v === 'jpeg' || v === 'jpg' ? 'jpeg' : v === 'webp' ? 'webp' : 'png'
}

/** 服务商不一定按要求的格式返回（Gemini、Seedream 常给 JPEG）：按文件头决定扩展名 */
function sniffFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return undefined
}

function parseSize(size: unknown): { width: number; height: number } | undefined {
  const match = typeof size === 'string' ? /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim()) : null
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** Gemini 只接受固定的画面比例：取最接近的一档 */
const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
export function nearestAspectRatio(size: unknown): string | undefined {
  const parsed = parseSize(size)
  if (!parsed) return undefined
  const target = Math.log(parsed.width / parsed.height)
  let best = GEMINI_RATIOS[0]
  let gap = Infinity
  for (const ratio of GEMINI_RATIOS) {
    const [w, h] = ratio.split(':').map(Number)
    const diff = Math.abs(Math.log(w / h) - target)
    if (diff < gap) {
      gap = diff
      best = ratio
    }
  }
  return best
}

/**
 * Seedream 4.5 起要求总像素不少于 2560×1440；按原比例放大到下限，边长取 16 的倍数。
 * `2K`、`4K` 这类写法与已满足下限的尺寸原样传。
 */
const SEEDREAM_MIN_PIXELS = 2560 * 1440
export function seedreamSize(size: unknown): string {
  const parsed = parseSize(size)
  if (!parsed) return typeof size === 'string' && /^[124]K$/i.test(size.trim()) ? size.trim().toUpperCase() : '2K'
  const { width, height } = parsed
  if (width * height >= SEEDREAM_MIN_PIXELS) return `${width}x${height}`
  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / (width * height))
  const up = (value: number): number => Math.ceil((value * scale) / 16) * 16
  return `${up(width)}x${up(height)}`
}

/** 错误响应里取一句可读原因（不回显请求头或整段响应体） */
async function errorReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown }
    const message = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message ?? json.detail
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200)
  } catch {
    /* 非 JSON 错误体可能含隐私或 HTML，不回显原文 */
  }
  return `HTTP ${response.status}：服务未返回可读错误信息`
}

class ImageProviderError extends Error {
  constructor(readonly code: string, readonly reason?: string) {
    super(reason ? `${code}: ${reason}` : code)
  }
}

async function responseJson<T>(response: Response, prefix: string): Promise<T> {
  try { return await response.json() as T }
  catch { throw new ImageProviderError(`${prefix}_invalid_response`, `HTTP ${response.status}：响应不是有效 JSON`) }
}

async function httpError(prefix: string, response: Response): Promise<ImageProviderError> {
  const reason = await errorReason(response)
  if (response.status === 401 || response.status === 403) return new ImageProviderError(`${prefix}_auth_rejected`, reason)
  if (response.status === 429) return new ImageProviderError(`${prefix}_rate_limited`, reason)
  return new ImageProviderError(`${prefix}_http_${response.status}`, reason)
}

/** 生图常要一两分钟；整次请求的上限 */
const REQUEST_TIMEOUT_MS = 6 * 60_000

function imageSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 未支持 signal 的只读探测/凭证等待也能及时退出；迟到结果不会继续本次生成。 */
export function waitForImage<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new ImageProviderError('image_cancelled'))
    if (signal.aborted) {
      void pending.catch(() => undefined)
      cancel()
      return
    }
    signal.addEventListener('abort', cancel, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)).catch(() => undefined)
  })
}

function checkImageCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImageProviderError('image_cancelled')
}

/* ------------------------------------------------------------ 参考图（编辑） */

interface SourceImage {
  name: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: Buffer
}

const SOURCE_MIME: Record<string, SourceImage['mime']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const MAX_SOURCES = 4
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 编辑模式的参考图只能来自当前项目或砚的受控产物目录（上一张生成结果），
 * 免得模型把项目外的任意文件发给外部服务。
 */
async function loadSources(paths: string[] | undefined, roots: { cwd?: string; artifactDir: string }): Promise<SourceImage[]> {
  if (!paths?.length) return []
  if (paths.length > MAX_SOURCES) throw new ImageProviderError('image_source_too_many', `最多 ${MAX_SOURCES} 张参考图`)
  const allowedRoots = await Promise.all([roots.cwd, roots.artifactDir]
    .filter((root): root is string => !!root)
    .map((root) => realpath(root).catch(() => null)))
  const out: SourceImage[] = []
  for (const raw of paths) {
    const path = resolve(roots.cwd ?? roots.artifactDir, raw)
    if (!(roots.cwd && inside(roots.cwd, path)) && !inside(roots.artifactDir, path)) {
      throw new ImageProviderError('image_source_outside_project', raw)
    }
    // stat/readFile 会跟随联接与符号链接，必须在读取前校验真实目标与真实允许根。
    const source = await realpath(path).catch(() => null)
    if (!source) throw new ImageProviderError('image_source_missing', raw)
    if (!allowedRoots.some((root) => root && inside(root, source))) {
      throw new ImageProviderError('image_source_outside_project', raw)
    }
    const mime = SOURCE_MIME[extname(path).toLowerCase()]
    if (!mime) throw new ImageProviderError('image_source_unsupported', raw)
    const info = await stat(source).catch(() => null)
    if (!info?.isFile()) throw new ImageProviderError('image_source_missing', raw)
    if (info.size > MAX_SOURCE_BYTES) throw new ImageProviderError('image_source_too_large', raw)
    out.push({ name: path.split(/[\\/]/).pop() ?? 'source', mime, bytes: await readFile(source) })
  }
  return out
}

const dataUrl = (source: SourceImage): string => `data:${source.mime};base64,${source.bytes.toString('base64')}`

interface Generated {
  bytes: Buffer
  model: string
  revisedPrompt?: string
}

/* ------------------------------------------------------------ ChatGPT（Codex） */

/** 中转对话模型：只负责把提示词交给生图工具，用最便宜的一档，低推理 */
const CODEX_RELAY_MODEL = 'gpt-6-luna'
/** 订阅里没有上面那档时退回的模型 */
const CODEX_RELAY_FALLBACK = 'gpt-5.5'

/**
 * ChatGPT 后端没有独立的生图接口：由一个对话模型调用 image_generation 工具出图。
 * 提示词已由会话模型写好，中转模型被要求原样转交，不参与创作。
 * 请求里的 model 若是 gpt-image-* 只作记录，不能当对话模型发出去。
 */
async function codexImage(req: ImageGenerationRequest, sources: SourceImage[], credentials: ImageCredentialSource, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const auth = await credentials.codex()
  if (!auth) throw new ImageProviderError('codex_auth_missing')
  const requested = stringParam(req.model, '')
  let imageModel = /^gpt-image/i.test(requested) ? requested : defaultImageModel('codex')
  let chatModel = requested && !/^gpt-image/i.test(requested) ? requested : envOr('YAN_IMAGE_CODEX_MODEL', CODEX_RELAY_MODEL)
  let pinModel = true
  const payload = (): Record<string, unknown> => ({
    model: chatModel,
    instructions: sources.length
      ? 'Call the image_generation tool once to edit the provided image(s). Use the user message verbatim as the prompt; do not rewrite, expand or translate it. Do not reply with text or ask questions.'
      : 'Call the image_generation tool once. Use the user message verbatim as the prompt; do not rewrite, expand or translate it. Do not reply with text or ask questions.',
    reasoning: { effort: 'low' },
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: req.prompt },
        ...sources.map((source) => ({ type: 'input_image', image_url: dataUrl(source) }))
      ]
    }],
    tools: [{
      type: 'image_generation',
      // 不写 model 时由 ChatGPT 后端自选，产物上的模型名就无从确认
      ...(pinModel ? { model: imageModel } : {}),
      size: stringParam(req.size, '1024x1024'),
      quality: stringParam(req.quality, 'auto'),
      output_format: formatOf(req.format),
      background: stringParam(req.background, 'auto')
    }],
    parallel_tool_calls: false,
    stream: true,
    // Codex 的 ChatGPT 后端要求图像请求显式不存储；也符合本地文件产物的隐私边界。
    store: false
  })
  const send = (): Promise<Response> => fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      /* 与令牌签发方一致：砚内登录与 pi 同一个 client，Codex CLI 的令牌沿用原来的标识 */
      originator: auth.source === 'yan' ? 'pi' : 'codex_desktop',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(payload()),
    signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
  })
  report?.('requesting', auth.source === 'yan' ? '使用砚内 ChatGPT 登录' : '使用 Codex CLI 登录')
  let response = await send()
  /* 订阅不开放所指模型（400 且提到 model）：报错点名中转模型就换回 gpt-5.5，否则去掉生图模型交给后端自选，并如实标成未知 */
  for (let retry = 0; response.status === 400 && retry < 2; retry += 1) {
    const reason = await errorReason(response)
    if (!/model/i.test(reason)) throw new ImageProviderError('codex_http_400', reason)
    if (reason.includes(chatModel) && chatModel !== CODEX_RELAY_FALLBACK) chatModel = CODEX_RELAY_FALLBACK
    else if (pinModel) {
      pinModel = false
      imageModel = 'chatgpt-default'
    } else throw new ImageProviderError('codex_http_400', reason)
    response = await send()
  }
  if (!response.ok) throw await httpError('codex', response)
  if (!response.body) throw new ImageProviderError('codex_empty_stream')
  report?.('generating')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalB64 = ''
  let revisedPrompt: string | undefined
  let failure: string | undefined
  let partials = 0
  const consume = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const text = line.slice(5).trim()
      if (!text || text === '[DONE]') continue
      try {
        const event = JSON.parse(text) as {
          type?: string
          item?: { type?: string; result?: string; revised_prompt?: string }
          response?: { error?: { message?: string } }
          error?: { message?: string }
          message?: string
        }
        const item = event.item
        if (item?.type === 'image_generation_call' && item.result) {
          finalB64 = item.result
          revisedPrompt = item.revised_prompt
        } else if (event.type === 'response.image_generation_call.partial_image') {
          partials += 1
          report?.('generating', `已收到第 ${partials} 张预览`)
        } else if (event.type === 'response.failed' || event.type === 'error') {
          failure = event.response?.error?.message ?? event.error?.message ?? event.message ?? failure
        }
      } catch {
        /* 每个事件在空行处完整切分；解析失败的行忽略 */
      }
    }
  }
  while (true) {
    const next = await reader.read()
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    events.forEach(consume)
    if (next.done) break
  }
  consume(buffer)
  if (!finalB64) throw new ImageProviderError(failure ? 'codex_response_failed' : 'codex_image_result_missing', failure?.slice(0, 200))
  return { bytes: Buffer.from(finalB64, 'base64'), model: imageModel, revisedPrompt }
}

/* ------------------------------------------------------------ OpenAI 及兼容端点 */

async function openAiImage(req: ImageGenerationRequest, sources: SourceImage[], baseUrl: string, token: string, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const model = stringParam(req.model, defaultImageModel('openai'))
  const base = baseUrl.replace(/\/+$/, '')
  const fields = {
    model,
    prompt: req.prompt,
    size: stringParam(req.size, '1024x1024'),
    quality: stringParam(req.quality, 'auto'),
    background: stringParam(req.background, 'auto'),
    output_format: formatOf(req.format),
    n: '1'
  }
  report?.('requesting')
  let response: Response
  if (sources.length) {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    for (const source of sources) form.append('image[]', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), source.name)
    response = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
    })
  } else {
    response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, n: 1 }),
      signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
    })
  }
  if (!response.ok) throw await httpError('image_api', response)
  report?.('generating')
  const json = await responseJson<{ data?: Array<{ b64_json?: string; revised_prompt?: string }> }>(response, 'image_api')
  const b64 = json.data?.[0]?.b64_json
  if (!b64) throw new ImageProviderError('image_api_result_missing')
  return { bytes: Buffer.from(b64, 'base64'), model, revisedPrompt: json.data?.[0]?.revised_prompt }
}

/* ------------------------------------------------------------ Google Gemini */

/* 服务商的模型会按季度更新、旧型号下线；没指定模型时按列表挑最新一档，每个进程只查一次 */
const latestModels = new Map<string, Promise<string | null>>()

function cachedLatest(cacheKey: string, load: () => Promise<string | null>): Promise<string | null> {
  let pending = latestModels.get(cacheKey)
  if (!pending) {
    pending = load().catch(() => null)
    latestModels.set(cacheKey, pending)
    void pending.then((value) => { if (value === null && latestModels.get(cacheKey) === pending) latestModels.delete(cacheKey) })
  }
  return pending
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** 最新的 gemini-X.Y-flash-image（正式版，不含 lite / preview / pro） */
function latestGoogleImageModel(base: string, key: string): Promise<string | null> {
  return cachedLatest(`google ${base} ${key.slice(-6)}`, async () => {
    const versions: string[] = []
    let pageToken = ''
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) })
      const response = await fetch(`${base}/models?${query}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const json = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string }
      versions.push(...(json.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
        .map((model) => /^(?:models\/)?gemini-([\d.]+)-flash-image$/.exec(model.name ?? '')?.[1])
        .filter((version): version is string => !!version))
      pageToken = json.nextPageToken ?? ''
      if (!pageToken) break
    }
    versions.sort(compareVersions)
    return versions.length ? `gemini-${versions.at(-1)}-flash-image` : null
  })
}

/** 最新的 Seedream：跳过已下线 / 即将下线的，按型号末尾的发布日期取最新 */
function latestSeedreamModel(base: string, key: string): Promise<string | null> {
  return cachedLatest(`doubao ${base} ${key.slice(-6)}`, async () => {
    const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const json = await response.json() as { data?: Array<{ id?: string; status?: string; task_type?: unknown }> }
    const dated = (json.data ?? [])
      .filter((model) => /seedream/i.test(model.id ?? '') && !/shutdown|retir|deprecat/i.test(model.status ?? ''))
      .filter((model) => !Array.isArray(model.task_type) || model.task_type.includes('TextToImage'))
      .map((model) => ({ id: model.id as string, date: /-(\d{6})$/.exec(model.id as string)?.[1] ?? '' }))
      .filter((model) => model.date)
      .sort((a, b) => a.date.localeCompare(b.date))
    return dated.at(-1)?.id ?? null
  })
}

async function googleImage(req: ImageGenerationRequest, sources: SourceImage[], key: string, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const base = envOr('YAN_IMAGE_GOOGLE_BASE', GOOGLE_BASE).replace(/\/+$/, '')
  const pinned = stringParam(req.model, '') || process.env.YAN_IMAGE_GOOGLE_MODEL?.trim() || ''
  const model = (pinned || await latestGoogleImageModel(base, key) || defaultImageModel('google')).replace(/^models\//, '')
  const aspectRatio = nearestAspectRatio(req.size)
  report?.('requesting')
  const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: req.prompt },
          ...sources.map((source) => ({ inlineData: { mimeType: source.mime, data: source.bytes.toString('base64') } }))
        ]
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {})
      }
    }),
    signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
  })
  if (!response.ok) throw await httpError('google', response)
  report?.('generating')
  const json = await responseJson<{
    promptFeedback?: { blockReason?: string }
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }>
  }>(response, 'google')
  if (json.promptFeedback?.blockReason) throw new ImageProviderError('google_image_blocked', json.promptFeedback.blockReason)
  const parts = json.candidates?.[0]?.content?.parts ?? []
  const image = parts.find((part) => part.inlineData?.data)
  if (!image?.inlineData?.data) {
    const reason = json.candidates?.[0]?.finishReason
    throw new ImageProviderError(reason && reason !== 'STOP' ? 'google_image_blocked' : 'google_image_result_missing', reason)
  }
  const note = parts.map((part) => part.text ?? '').join('').trim()
  return { bytes: Buffer.from(image.inlineData.data, 'base64'), model, ...(note ? { revisedPrompt: note.slice(0, 500) } : {}) }
}

/* ------------------------------------------------------------ 火山方舟（豆包 Seedream） */

async function doubaoImage(req: ImageGenerationRequest, sources: SourceImage[], key: string, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const base = envOr('YAN_IMAGE_DOUBAO_BASE', DOUBAO_BASE).replace(/\/+$/, '')
  const pinned = stringParam(req.model, '') || process.env.YAN_IMAGE_DOUBAO_MODEL?.trim() || ''
  const model = pinned || await latestSeedreamModel(base, key) || defaultImageModel('doubao')
  report?.('requesting')
  const response = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      size: seedreamSize(req.size),
      response_format: 'b64_json',
      // 不传 sequential_image_generation：默认就是单张，且 5.0 flash 起不认这个字段
      watermark: false,
      ...(sources.length ? { image: sources.length === 1 ? dataUrl(sources[0]) : sources.map(dataUrl) } : {})
    }),
    signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
  })
  if (!response.ok) throw await httpError('doubao', response)
  report?.('generating')
  const json = await responseJson<{ data?: Array<{ b64_json?: string }>; error?: { message?: string } }>(response, 'doubao')
  const b64 = json.data?.find((item) => item.b64_json)?.b64_json
  if (!b64) throw new ImageProviderError('doubao_image_result_missing', json.error?.message)
  return { bytes: Buffer.from(b64, 'base64'), model }
}

/* ------------------------------------------------------------ 本机服务 */

async function sdWebUiImage(req: ImageGenerationRequest, sources: SourceImage[], server: LocalModelServer, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const model = stringParam(req.model, server.models[0] ?? '')
  const size = parseSize(req.size) ?? { width: 1024, height: 1024 }
  report?.('requesting', `${server.name} · ${model}`)
  const body = {
    prompt: req.prompt,
    width: size.width,
    height: size.height,
    steps: 25,
    ...(model ? { override_settings: { sd_model_checkpoint: model }, override_settings_restore_afterwards: true } : {}),
    ...(sources.length ? { init_images: [sources[0].bytes.toString('base64')], denoising_strength: 0.6 } : {})
  }
  const response = await fetch(`${server.baseUrl}/sdapi/v1/${sources.length ? 'img2img' : 'txt2img'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
  })
  if (!response.ok) throw await httpError('local', response)
  report?.('generating')
  const json = await responseJson<{ images?: string[] }>(response, 'local')
  const b64 = json.images?.[0]
  if (!b64) throw new ImageProviderError('local_image_result_missing')
  return { bytes: Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64'), model: model || server.name }
}

/** 本机生图比云端慢，首次还要加载十几 GB 的模型；排队与执行的总上限 */
const LOCAL_TIMEOUT_MS = 15 * 60_000

/**
 * 候选工作流的顺序：请求里的 model（工作流文件名，可省略 .json 与目录）或 YAN_COMFYUI_WORKFLOW 指定的只用它；
 * 否则按同类（编辑用图生图，其余用文生图）排好的顺序逐个尝试。
 */
export function comfyCandidates(entries: ComfyWorkflowEntry[], wanted: string, edit: boolean): ComfyWorkflowEntry[] {
  const normalize = (name: string): string => name.toLowerCase().replace(/\.json$/, '').replace(/^.*\//, '')
  const named = wanted || process.env.YAN_COMFYUI_WORKFLOW?.trim() || ''
  if (named) {
    const hit = entries.find((entry) => entry.name === named || normalize(entry.name) === normalize(named))
    if (hit) return [hit]
  }
  return entries.filter((entry) => entry.kind === (edit ? 'image-to-image' : 'text-to-image'))
}

async function comfyUpload(server: LocalModelServer, source: SourceImage, signal?: AbortSignal): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), `yan-${randomUUID().slice(0, 8)}-${source.name}`)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const response = await fetch(`${server.baseUrl}/upload/image`, { method: 'POST', body: form, signal: imageSignal(60_000, signal) })
  if (!response.ok) throw await httpError('local', response)
  const json = (await response.json()) as { name?: string; subfolder?: string }
  if (!json.name) throw new ImageProviderError('local_upload_failed')
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name
}

async function comfyObjectInfo(server: LocalModelServer, types: string[], cache: Record<string, ObjectInfoEntry>, signal?: AbortSignal): Promise<Record<string, ObjectInfoEntry>> {
  for (const type of types) {
    if (cache[type]) continue
    checkImageCancelled(signal)
    const response = await fetch(`${server.baseUrl}/object_info/${encodeURIComponent(type)}`, { signal: imageSignal(10_000, signal) }).catch(() => null)
    if (!response?.ok) continue
    const entry = ((await response.json().catch(() => ({}))) as Record<string, ObjectInfoEntry>)[type]
    if (entry) cache[type] = entry
  }
  return cache
}

/**
 * 逐个尝试候选工作流：缺自定义节点、找不到提示词、或用到云端 API 节点（要 ComfyUI 账号与额度）的跳过，
 * 换下一个；用户点名的工作流不跳过云端节点，问题直接报出来。
 */
async function buildComfyPrompt(
  server: LocalModelServer,
  candidates: ComfyWorkflowEntry[],
  named: boolean,
  request: { prompt: string; width?: number; height?: number; images?: string[] },
  signal?: AbortSignal
): Promise<{ prompt: ApiPrompt; workflow: string }> {
  const cache: Record<string, ObjectInfoEntry> = {}
  const problems: string[] = []
  for (const candidate of candidates) {
    try {
      checkImageCancelled(signal)
      const workflow = (await waitForImage(fetchComfyWorkflow(server.baseUrl, candidate.name), signal)) as UiWorkflow | ApiPrompt
      const info = await comfyObjectInfo(server, workflowNodeTypes(workflow), cache, signal)
      const converted = toApiPrompt(workflow, info)
      if (!named && usesApiNodes(converted, info)) {
        problems.push(`${candidate.name}：用到 ComfyUI 云端 API 节点`)
        continue
      }
      return { prompt: applyRequest(converted, { ...request, filenamePrefix: 'Inkstone/yan' }), workflow: candidate.name }
    } catch (error) {
      checkImageCancelled(signal)
      problems.push(`${candidate.name}：${error instanceof WorkflowError ? error.reason ?? error.code : error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ImageProviderError(candidates.length ? 'local_workflow_unsupported' : 'local_workflow_missing', problems.slice(0, 3).join('；') || undefined)
}

/** ComfyUI：用用户保存的工作流，只替换提示词、种子、尺寸、参考图与保存前缀 */
async function comfyImage(req: ImageGenerationRequest, sources: SourceImage[], server: LocalModelServer, report?: ImageProgressReporter, signal?: AbortSignal): Promise<Generated> {
  const entries = await waitForImage(listComfyWorkflows(server.baseUrl).catch(() => []), signal)
  const wanted = stringParam(req.model, '')
  const candidates = comfyCandidates(entries, wanted, sources.length > 0)
  const requestedWorkflow = wanted || process.env.YAN_COMFYUI_WORKFLOW?.trim() || ''
  const namedHit = !!requestedWorkflow && candidates.length === 1 && entries.some((entry) => entry.name === candidates[0].name && (entry.name === requestedWorkflow || entry.name.toLowerCase().replace(/\.json$/, '').split('/').at(-1) === requestedWorkflow.toLowerCase().replace(/\.json$/, '').split('/').at(-1)))
  if (!candidates.length) {
    throw new ImageProviderError('local_workflow_missing', sources.length ? '没有可用的图生图工作流（含 LoadImage）' : '没有可用的文生图工作流')
  }
  report?.('requesting', `${server.name} · ${candidates[0].name}`)
  const images: string[] = []
  for (const source of sources) images.push(await comfyUpload(server, source, signal))
  const size = parseSize(req.size)
  const built = await buildComfyPrompt(server, candidates, namedHit, {
    prompt: req.prompt,
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(images.length ? { images } : {})
  }, signal)
  checkImageCancelled(signal)
  const prompt = built.prompt
  const chosen = { name: built.workflow }
  const queued = await fetch(`${server.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: `yan-${randomUUID()}` }),
    signal: imageSignal(30_000, signal)
  })
  if (!queued.ok) throw await httpError('local', queued)
  const promptId = ((await queued.json()) as { prompt_id?: string }).prompt_id
  if (!promptId) throw new ImageProviderError('local_image_result_missing')
  // 只删除本次排队项；/interrupt 是全局中断，不能影响正在执行的其他会话或用户工作流。
  const cancelQueued = (): void => {
    void fetch(`${server.baseUrl}/queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5_000)
    }).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelQueued, { once: true })
  try {
    if (signal?.aborted) { cancelQueued(); checkImageCancelled(signal) }
    report?.('generating', `${server.name} · ${chosen.name}`)
    const deadline = Date.now() + LOCAL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(1_000, undefined, { signal })
      checkImageCancelled(signal)
      const history = await fetch(`${server.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: imageSignal(10_000, signal) }).catch(() => null)
      checkImageCancelled(signal)
      if (!history?.ok) continue
      const entry = ((await history.json()) as Record<string, {
        status?: { status_str?: string; completed?: boolean; messages?: Array<[string, { exception_message?: string }]> }
        outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>
      }>)[promptId]
      if (!entry) continue
      if (entry.status?.status_str === 'error') {
        const failed = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]?.exception_message
        throw new ImageProviderError('local_workflow_failed', failed?.slice(0, 200))
      }
      const outputs = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])
      const image = outputs.find((item) => item.type === 'output') ?? outputs[0]
      if (!image) {
        if (entry.status?.completed) throw new ImageProviderError('local_image_result_missing')
        continue
      }
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
      const file = await fetch(`${server.baseUrl}/view?${query}`, { signal: imageSignal(30_000, signal) })
      if (!file.ok) throw await httpError('local', file)
      return { bytes: Buffer.from(await file.arrayBuffer()), model: chosen.name }
    }
    cancelQueued()
    throw new ImageProviderError('local_timeout')
  } finally {
    signal?.removeEventListener('abort', cancelQueued)
  }
}

/* ------------------------------------------------------------ mock */

function mockSvg(prompt: string): Buffer {
  const safe = Array.from(prompt).slice(0, 60).join('').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c))
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="180" fill="#101318"/><circle cx="512" cy="450" r="240" fill="#303A47"/><path d="M350 450h324v170H350z" fill="#F3F4F6"/><text x="512" y="820" fill="#98A2B3" font-size="34" text-anchor="middle" font-family="sans-serif">${safe}</text></svg>`, 'utf8')
}

/* ------------------------------------------------------------ 入口 */

const PROVIDER_LABEL: Record<Exclude<ResolvedImageProvider, 'unavailable'>, string> = {
  codex: 'ChatGPT（Codex）',
  openai: 'OpenAI',
  compatible: 'OpenAI 兼容端点',
  google: 'Google Gemini',
  doubao: '火山方舟（豆包）',
  local: '本机服务',
  mock: '本地预览'
}

/** 一条通道都没有时告诉用户能做什么：已安装但没启动的本机生图服务优先点名 */
async function unavailableHint(): Promise<string> {
  const stopped = (await detectLocalModelServers().catch(() => []))
    .filter((server) => server.purpose === 'image' && !server.running && server.installDir)
    .map((server) => `${server.name}（${server.installDir}）`)
  const remote = '在设置-模型接入登录 ChatGPT，或配置 OpenAI / Google Gemini / 火山方舟 API key'
  if (stopped.length) return `本机已安装 ${stopped.join('、')}，但没有运行，启动后重试；或${remote}`
  // 本机生图要独立显卡、首次下载数 GB 模型，是否安装由用户决定
  return `${remote}；或在本机安装 ComfyUI 等生图软件（需要独立显卡，首次要下载数 GB 模型）。请把这些选项告诉用户并询问，不要自行下载或安装`
}

export interface ImageGenerationContext {
  sessionFile: string
  messageId: string
  artifactDir: string
  /** 编辑模式的参考图只允许来自这个目录或 artifactDir */
  cwd?: string
  onProgress?: ImageProgressReporter
  credentials?: ImageCredentialSource
  /** 调用方已探测过就传进来，避免重复探测 */
  availability?: ImageAvailability
  signal?: AbortSignal
}

export async function generateImage(request: ImageGenerationRequest, context: ImageGenerationContext): Promise<ImageGenerationResult> {
  checkImageCancelled(context.signal)
  return waitForImage(generateImageImpl(request, context), context.signal)
}

async function generateImageImpl(request: ImageGenerationRequest, context: ImageGenerationContext): Promise<ImageGenerationResult> {
  const prompt = stringParam(request.prompt, '')
  if (!prompt) throw new ImageProviderError('image_prompt_missing')
  if (request.provider !== undefined && !isImageProvider(request.provider)) throw new ImageProviderError('image_provider_unknown', String(request.provider))
  const credentials = context.credentials ?? hostImageCredentials
  const availability = context.availability ?? await detectImageProviders(credentials)
  const provider = resolveImageProvider(request.provider, availability)
  if (provider === 'unavailable') throw new ImageProviderError('image_provider_unavailable', await unavailableHint())
  const signal = context.signal
  const report: ImageProgressReporter = (stage, detail) => {
    checkImageCancelled(signal)
    context.onProgress?.(stage, detail)
    checkImageCancelled(signal)
  }
  report?.('preparing', provider === 'mock' ? '正在准备本地预览' : `已选择 ${PROVIDER_LABEL[provider]}`)
  const sources = request.mode === 'edit' || request.sourcePaths?.length
    ? await loadSources(request.sourcePaths, { cwd: context.cwd, artifactDir: context.artifactDir })
    : []
  if (request.mode === 'edit' && !sources.length) throw new ImageProviderError('image_source_missing', '编辑模式需要 sourcePaths')
  const req = { ...request, prompt }

  let generated: Generated
  if (provider === 'mock') {
    report?.('generating', '正在生成本地预览')
    generated = { bytes: mockSvg(prompt), model: 'yan-mock-svg' }
  } else if (provider === 'codex') {
    generated = await codexImage(req, sources, credentials, report, signal)
  } else if (provider === 'google') {
    const key = await credentials.secret('google')
    if (!key) throw new ImageProviderError('google_api_key_missing')
    generated = await googleImage(req, sources, key, report, signal)
  } else if (provider === 'doubao') {
    const key = await credentials.secret('doubao')
    if (!key) throw new ImageProviderError('doubao_api_key_missing')
    generated = await doubaoImage(req, sources, key, report, signal)
  } else if (provider === 'local') {
    let server = availability.local
    if (!server && (availability.localLaunch || request.provider === 'local')) {
      try {
        server = await waitForImage(ensureComfyRunning((detail) => {
          if (!signal?.aborted) report('preparing', detail)
        }), signal)
      } catch (error) {
        if (error instanceof ComfyLaunchError) throw new ImageProviderError(error.code, error.reason)
        throw error
      }
    }
    if (!server) throw new ImageProviderError('local_service_missing')
    if (server.kind === 'comfyui') {
      // 砚拉起的 ComfyUI 出图期间不会被空闲计时关掉
      const release = holdManagedComfy(server.baseUrl)
      try {
        generated = await comfyImage(req, sources, server, report, signal)
      } finally {
        release()
      }
    } else generated = await sdWebUiImage(req, sources, server, report, signal)
  } else {
    // 自定义端点只能使用显式配置的专用凭证，不能携带另一供应商的密钥。
    const key = provider === 'compatible' ? process.env.YAN_IMAGE_API_KEY?.trim() : await credentials.secret('openai')
    if (!key) throw new ImageProviderError(provider === 'compatible' ? 'compatible_api_key_missing' : 'openai_api_key_missing')
    generated = await openAiImage({ ...req, model: stringParam(req.model, defaultImageModel(provider)) }, sources, imageProviderEndpoint(provider, availability), key, report, signal)
  }

  if (generated.bytes.length === 0) throw new ImageProviderError('image_result_empty')
  const format = provider === 'mock' ? 'svg' : sniffFormat(generated.bytes) ?? formatOf(request.format)
  report?.('saving', '正在保存受控文件')
  const artifact = await new ArtifactStore(context.artifactDir).save({
    sessionFile: context.sessionFile,
    messageId: context.messageId,
    filename: `yan-image-${randomUUID().slice(0, 8)}.${format}`,
    bytes: generated.bytes,
    provider,
    model: generated.model,
    description: request.description ?? prompt
  })
  if (artifact.bytes <= 0) throw new ImageProviderError('artifact_empty')
  report?.('done', `${artifact.filename} · ${artifact.bytes} bytes`)
  return { provider, model: generated.model, artifact, revisedPrompt: generated.revisedPrompt }
}
