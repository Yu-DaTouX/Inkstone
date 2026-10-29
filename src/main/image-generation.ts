import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AssistantArtifact, ImageGenerationStage } from '../shared/ipc'
import type { LocalModelServer } from '../shared/custom-provider'
import { ArtifactStore } from './artifacts'
import { hostImageCredentials, type ImageCredentialSource } from './image-credentials'
import { detectLocalImageService, detectLocalModelServers } from './local-models'

export const IMAGE_PROVIDERS = ['auto', 'codex', 'openai', 'compatible', 'google', 'doubao', 'local', 'mock'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]
export type ResolvedImageProvider = Exclude<ImageProvider, 'auto'> | 'unavailable'

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

export interface ImageAvailability {
  codex: boolean
  openai: boolean
  compatible: boolean
  google: boolean
  doubao: boolean
  local: LocalModelServer | null
}

export function isImageProvider(value: unknown): value is ImageProvider {
  return typeof value === 'string' && (IMAGE_PROVIDERS as readonly string[]).includes(value)
}

export async function detectImageProviders(
  credentials: ImageCredentialSource = hostImageCredentials,
  detectLocal: () => Promise<LocalModelServer | null> = detectLocalImageService
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
    local
  }
}

export function resolveImageProvider(requested: ImageProvider | undefined, available: ImageAvailability): ResolvedImageProvider {
  const configured = process.env.YAN_IMAGE_PROVIDER?.trim()
  const value = requested && requested !== 'auto' ? requested : isImageProvider(configured) ? configured : 'auto'
  if (value !== 'auto') return value
  for (const provider of AUTO_ORDER) {
    if (provider === 'local' ? available.local : available[provider]) return provider
  }
  return 'unavailable'
}

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare'

export function defaultImageModel(provider: ResolvedImageProvider, available?: ImageAvailability): string {
  switch (provider) {
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
      return envOr('YAN_IMAGE_COMPATIBLE_MODEL', 'gpt-image-2')
    default:
      return envOr('YAN_IMAGE_OPENAI_MODEL', OPENAI_IMAGE_MODEL)
  }
}

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
      return available?.local?.baseUrl ?? ''
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

export function imageProviderNeedsConfirmation(provider: ResolvedImageProvider, available?: ImageAvailability): boolean {
  if (provider === 'openai' || provider === 'compatible' || provider === 'google' || provider === 'doubao') return true
  return provider === 'local' && !isLoopback(imageProviderEndpoint(provider, available))
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function formatOf(value: unknown): 'png' | 'jpeg' | 'webp' {
  const v = String(value ?? 'png').toLowerCase()
  return v === 'jpeg' || v === 'jpg' ? 'jpeg' : v === 'webp' ? 'webp' : 'png'
}

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

async function errorReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown }
    const message = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message ?? json.detail
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200)
  } catch {
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

const REQUEST_TIMEOUT_MS = 6 * 60_000

function imageSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

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

const CODEX_RELAY_MODEL = 'gpt-6-luna'
const CODEX_RELAY_FALLBACK = 'gpt-5.5'

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
      ...(pinModel ? { model: imageModel } : {}),
      size: stringParam(req.size, '1024x1024'),
      quality: stringParam(req.quality, 'auto'),
      output_format: formatOf(req.format),
      background: stringParam(req.background, 'auto')
    }],
    parallel_tool_calls: false,
    stream: true,
    store: false
  })
  const send = (): Promise<Response> => fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      originator: auth.source === 'yan' ? 'pi' : 'codex_desktop',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(payload()),
    signal: imageSignal(REQUEST_TIMEOUT_MS, signal)
  })
  report?.('requesting', auth.source === 'yan' ? '使用砚内 ChatGPT 登录' : '使用 Codex CLI 登录')
  let response = await send()
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
  let replyText = ''
  const seenTypes = new Set<string>()
  const takeImage = (item: { type?: string; result?: string; revised_prompt?: string } | undefined): void => {
    if (item?.type !== 'image_generation_call' || !item.result) return
    finalB64 = item.result
    revisedPrompt = item.revised_prompt
  }
  const consume = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const text = line.slice(5).trim()
      if (!text || text === '[DONE]') continue
      try {
        const event = JSON.parse(text) as {
          type?: string
          item?: { type?: string; result?: string; revised_prompt?: string }
          response?: { error?: { message?: string }; output?: Array<{ type?: string; result?: string; revised_prompt?: string }> }
          error?: { message?: string }
          message?: string
          delta?: string
        }
        if (event.type) seenTypes.add(event.type)
        takeImage(event.item)
        if (!finalB64 && event.type === 'response.completed') for (const output of event.response?.output ?? []) takeImage(output)
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && replyText.length < 400) replyText += event.delta
        if (finalB64) continue
        if (event.type === 'response.image_generation_call.partial_image') {
          partials += 1
          report?.('generating', `已收到第 ${partials} 张预览`)
        } else if (event.type === 'response.failed' || event.type === 'error') {
          failure = event.response?.error?.message ?? event.error?.message ?? event.message ?? failure
        }
      } catch {
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
  if (!finalB64 && failure) throw new ImageProviderError('codex_response_failed', failure.slice(0, 200))
  if (!finalB64 && replyText.trim()) throw new ImageProviderError('codex_image_tool_not_called', replyText.trim().slice(0, 200))
  if (!finalB64) throw new ImageProviderError('codex_image_result_missing', `事件：${[...seenTypes].slice(0, 12).join(', ') || '无'}；预览图 ${partials} 张`)
  return { bytes: Buffer.from(finalB64, 'base64'), model: imageModel, revisedPrompt }
}

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

function mockSvg(prompt: string): Buffer {
  const safe = Array.from(prompt).slice(0, 60).join('').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c))
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="180" fill="#101318"/><circle cx="512" cy="450" r="240" fill="#303A47"/><path d="M350 450h324v170H350z" fill="#F3F4F6"/><text x="512" y="820" fill="#98A2B3" font-size="34" text-anchor="middle" font-family="sans-serif">${safe}</text></svg>`, 'utf8')
}

const PROVIDER_LABEL: Record<Exclude<ResolvedImageProvider, 'unavailable'>, string> = {
  codex: 'ChatGPT（Codex）',
  openai: 'OpenAI',
  compatible: 'OpenAI 兼容端点',
  google: 'Google Gemini',
  doubao: '火山方舟（豆包）',
  local: '本机服务',
  mock: '本地预览'
}

async function unavailableHint(): Promise<string> {
  const stopped = (await detectLocalModelServers().catch(() => []))
    .filter((server) => server.purpose === 'image' && !server.running && server.installDir)
    .map((server) => `${server.name}（${server.installDir}）`)
  const remote = '在设置-模型接入登录 ChatGPT，或配置 OpenAI / Google Gemini / 火山方舟 API key'
  if (stopped.length) return `本机已安装 ${stopped.join('、')}，但没有运行，启动后重试；或${remote}`
  return `${remote}；或启动本机 SD WebUI 图像服务。请把这些选项告诉用户并询问，不要自行下载或安装`
}

export interface ImageGenerationContext {
  sessionFile: string
  messageId: string
  artifactDir: string
  cwd?: string
  onProgress?: ImageProgressReporter
  credentials?: ImageCredentialSource
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
    const server = availability.local
    if (!server) throw new ImageProviderError('local_service_missing')
    generated = await sdWebUiImage(req, sources, server, report, signal)
  } else {
    const key = provider === 'compatible' ? process.env.YAN_IMAGE_API_KEY?.trim() : await credentials.secret('openai')
    if (!key) throw new ImageProviderError(provider === 'compatible' ? 'compatible_api_key_missing' : 'openai_api_key_missing')
    generated = await openAiImage({ ...req, model: stringParam(req.model, defaultImageModel(provider)) }, sources, imageProviderEndpoint(provider, availability), key, report, signal)
  }

  if (generated.bytes.length === 0) throw new ImageProviderError('image_result_empty')
  const format = provider === 'mock' ? 'svg' : sniffFormat(generated.bytes) ?? formatOf(request.format)
  checkImageCancelled(signal)
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
