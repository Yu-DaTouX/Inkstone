import { pick } from '../shared/ui-lang'
import { copyFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { atomicWriteFile } from './atomic-write'
import { noteModelsWritten } from './models-watch'
import {
  describeDiscoveredModels,
  hasExecutablePrefix,
  mergeCustomProviders,
  modelsWriteRisk,
  parseModelEntries,
  validateBaseUrl,
  type CustomProviderDiscoverResult,
  type DiscoveredModel,
  readCustomProviders,
  validateCustomProvider,
  type CustomProviderInput,
  type CustomProviderTestResult,
  type CustomProviderView,
  type LocalModelInput
} from '../shared/custom-provider'
import { readPiModelCatalog } from './pi-model-catalog'
import { resolveNativeConfigValue } from './quota-credentials'
import { isLocalBaseUrl } from '../shared/model-capabilities'

export const MODELS_FILE = join(PI_AGENT_DIR, 'models.json')
const AUTO_BACKUP_PREFIX = 'models.json.bak-yan-auto-'
const AUTO_BACKUP_KEEP = 5

export interface CustomProviderResult {
  ok: boolean
  errors?: string[]
  providers?: CustomProviderView[]
}

type Json = Record<string, unknown>

async function readRaw(): Promise<{ ok: true; json: unknown; text: string | null } | { ok: false; error: string }> {
  try {
    const text = await readFile(MODELS_FILE, 'utf8')
    try {
      return { ok: true, json: JSON.parse(text), text }
    } catch {
      return { ok: false, error: pick(`models.json 不是合法 JSON，先修好再保存：${MODELS_FILE}`, `models.json is not valid JSON; fix it before saving: ${MODELS_FILE}`) }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, json: {}, text: null }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let modelsWriteChain: Promise<unknown> = Promise.resolve()
export function serializeModels<T>(work: () => Promise<T>): Promise<T> {
  const next = modelsWriteChain.then(work, work)
  modelsWriteChain = next.catch(() => undefined)
  return next
}

async function backupModels(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  try {
    await copyFile(MODELS_FILE, join(PI_AGENT_DIR, `${AUTO_BACKUP_PREFIX}${stamp}`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const backups = (await readdir(PI_AGENT_DIR)).filter((name) => name.startsWith(AUTO_BACKUP_PREFIX)).sort()
  await Promise.all(backups.slice(0, -AUTO_BACKUP_KEEP).map((name) => unlink(join(PI_AGENT_DIR, name)).catch(() => undefined)))
}

type PrepareModelWrite = (models: unknown) => Promise<(() => Promise<void>) | undefined>

export async function readConfigText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(json: Json, previous: string | null, apply?: () => Promise<void>): Promise<void> {
  await mkdir(PI_AGENT_DIR, { recursive: true })
  await backupModels()
  if (await readConfigText(MODELS_FILE) !== previous) {
    throw new Error(pick('models.json 已被其他程序修改，请重试', 'models.json was changed by another program; retry'))
  }
  const text = `${JSON.stringify(json, null, 2)}\n`
  await atomicWriteFile(MODELS_FILE, text)
  try {
    await apply?.()
  } catch (error) {
    try {
      if (await readConfigText(MODELS_FILE) !== text) throw new Error('models.json changed')
      if (previous === null) await unlink(MODELS_FILE)
      else {
        await atomicWriteFile(MODELS_FILE, previous)
        noteModelsWritten(previous)
      }
    } catch {
      throw new Error(pick('部分提交：启动器保存失败，无法安全回滚 models.json，请检查两个文件后重试', 'Partial commit: launcher save failed and models.json could not be safely rolled back; check both files before retrying'), { cause: error })
    }
    throw error
  }
  noteModelsWritten(text)
}

export async function contextWindowAssumed(provider: string, modelId: string): Promise<boolean> {
  const raw = await readRaw()
  if (!raw.ok || !raw.json || typeof raw.json !== 'object') return false
  const providers = (raw.json as Json).providers
  const entry = providers && typeof providers === 'object' ? (providers as Json)[provider] : undefined
  const models = entry && typeof entry === 'object' ? (entry as Json).models : undefined
  if (!Array.isArray(models)) return false
  const model = models.find((m): m is Json => !!m && typeof m === 'object' && (m as Json).id === modelId)
  if (!model) return false
  return !(typeof model.contextWindow === 'number' && model.contextWindow > 0)
}

export async function listCustomProviders(): Promise<CustomProviderView[]> {
  const raw = await readRaw()
  if (!raw.ok) return []
  return readCustomProviders(raw.json)
}

export async function saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderResult> {
  const filled = (input.models ?? []).filter((model) => model?.id?.trim())
  if (!filled.length) {
    const found = await discoverCustomProviderModels(input)
    if (found.ok) filled.push(...(found.entries ?? found.models.map((id) => ({ id }))))
  }
  const checked = validateCustomProvider({ ...input, models: filled })
  if (!checked.ok || !checked.value) return { ok: false, errors: checked.errors }

  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, errors: [raw.error] }
    const merged = mergeCustomProviders(raw.json, [checked.value!], [])
    if (merged.changed) {
      const risk = modelsWriteRisk(raw.json, merged.next)
      if (risk.dropped.length) return { ok: false, errors: [pick(`保存会删掉其他服务商（${risk.dropped.join('、')}），已取消`, `Saving would remove other providers (${risk.dropped.join(', ')}); cancelled`)] }
      if (risk.shrink.length && !input.confirmShrink) return { ok: false, shrink: risk.shrink, errors: risk.shrink.map((item) => pick(`${item.provider} 的模型会从 ${item.before} 个减少到 ${item.after} 个，需要确认`, `${item.provider} would go from ${item.before} models to ${item.after}; confirmation needed`)) }
      await writeAtomic(merged.next, raw.text)
    }
    return { ok: true, providers: readCustomProviders(merged.next) }
  })
}

export const MODEL_NAME_MAX = 120

export async function renameProviderModel(provider: string, modelId: string, name: string, prepare?: PrepareModelWrite): Promise<{ ok: boolean; error?: string }> {
  const value = name.replace(/\s+/g, ' ').trim()
  if (value.length > MODEL_NAME_MAX) return { ok: false, error: pick(`名称最多 ${MODEL_NAME_MAX} 个字符`, `Name can be at most ${MODEL_NAME_MAX} characters`) }
  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, error: raw.error }
    const base = (raw.json && typeof raw.json === 'object' ? raw.json : {}) as Json
    const providers = base.providers && typeof base.providers === 'object' ? (base.providers as Json) : {}
    const entry = providers[provider]
    const models = entry && typeof entry === 'object' && Array.isArray((entry as Json).models) ? ((entry as Json).models as unknown[]) : []
    const index = models.findIndex((m) => !!m && typeof m === 'object' && (m as Json).id === modelId)
    if (index < 0) return { ok: false, error: pick(`models.json 里没有模型 ${provider}/${modelId}`, `Model ${provider}/${modelId} is not in models.json`) }
    const model = { ...(models[index] as Json) }
    if ((typeof model.name === 'string' ? model.name : '') === value) return { ok: true }
    if (value) model.name = value
    else delete model.name
    const nextModels = [...models]
    nextModels[index] = model
    await writeAtomic({ ...base, providers: { ...providers, [provider]: { ...(entry as Json), models: nextModels } } }, raw.text, await prepare?.(raw.json))
    return { ok: true }
  })
}

export async function addProviderModel(provider: string, input: LocalModelInput, prepare?: PrepareModelWrite): Promise<{ ok: boolean; error?: string }> {
  const id = String(input.id ?? '').trim()
  if (!id) return { ok: false, error: pick('模型 ID 不能为空', 'Model ID is required') }
  if (hasExecutablePrefix(id)) return { ok: false, error: pick(`模型 ID「${id}」不能以 ! 开头`, `Model ID "${id}" cannot start with !`) }
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim()
  if (name.length > MODEL_NAME_MAX) return { ok: false, error: pick(`名称最多 ${MODEL_NAME_MAX} 个字符`, `Name can be at most ${MODEL_NAME_MAX} characters`) }
  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, error: raw.error }
    const base = (raw.json && typeof raw.json === 'object' ? raw.json : {}) as Json
    const providers = base.providers && typeof base.providers === 'object' ? (base.providers as Json) : {}
    const entry = providers[provider]
    if (!entry || typeof entry !== 'object') return { ok: false, error: pick(`models.json 里没有服务商 ${provider}`, `Provider ${provider} is not in models.json`) }
    const models = Array.isArray((entry as Json).models) ? ((entry as Json).models as unknown[]) : []
    if (models.some((m) => !!m && typeof m === 'object' && (m as Json).id === id)) {
      return { ok: false, error: pick(`模型「${id}」已存在`, `Model "${id}" already exists`) }
    }
    const next: Json = { id }
    if (name) next.name = name
    if (typeof input.contextWindow === 'number' && Number.isFinite(input.contextWindow) && input.contextWindow > 0) {
      next.contextWindow = Math.round(input.contextWindow)
    }
    if (typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0) {
      next.maxTokens = Math.round(input.maxTokens)
    }
    if (input.reasoning === true) {
      next.reasoning = true
      const template = models.find((m): m is Json => !!m && typeof m === 'object' && !!((m as Json).thinkingLevelMap && typeof (m as Json).thinkingLevelMap === 'object'))
      if (/inkling/i.test(id)) {
        next.thinkingLevelMap = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
      } else if (template) {
        next.thinkingLevelMap = { ...(template.thinkingLevelMap as Json) }
      }
    }
    const providerApi = typeof (entry as Json).api === 'string' ? String((entry as Json).api) : 'openai-completions'
    const providerUrl = typeof (entry as Json).baseUrl === 'string' ? String((entry as Json).baseUrl) : ''
    if (providerApi === 'openai-completions' && isLocalBaseUrl(providerUrl)) {
      next.compat = { promptCacheKeyMode: 'enabled' }
    }
    if (Array.isArray(input.input)) {
      const kinds = [...new Set(input.input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'))]
      if (kinds.includes('image') && !kinds.includes('text')) kinds.unshift('text')
      if (kinds.length) next.input = kinds
    }
    const nextModels = [...models, next]
    await writeAtomic({ ...base, providers: { ...providers, [provider]: { ...(entry as Json), models: nextModels } } }, raw.text, await prepare?.(raw.json))
    return { ok: true }
  })
}

export async function removeProviderModel(provider: string, modelId: string, prepare?: PrepareModelWrite): Promise<{ ok: boolean; error?: string }> {
  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, error: raw.error }
    const base = (raw.json && typeof raw.json === 'object' ? raw.json : {}) as Json
    const providers = base.providers && typeof base.providers === 'object' ? (base.providers as Json) : {}
    const entry = providers[provider]
    const models = entry && typeof entry === 'object' && Array.isArray((entry as Json).models) ? ((entry as Json).models as unknown[]) : []
    const index = models.findIndex((m) => !!m && typeof m === 'object' && (m as Json).id === modelId)
    if (index < 0) return { ok: false, error: pick(`models.json 里没有模型 ${provider}/${modelId}`, `Model ${provider}/${modelId} is not in models.json`) }
    if (models.length <= 1) return { ok: false, error: pick('至少要保留一个模型', 'At least one model must be kept') }
    const nextModels = models.filter((_, i) => i !== index)
    await writeAtomic({ ...base, providers: { ...providers, [provider]: { ...(entry as Json), models: nextModels } } }, raw.text, await prepare?.(raw.json))
    return { ok: true }
  })
}

export async function removeCustomProvider(id: string): Promise<CustomProviderResult> {
  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, errors: [raw.error] }
    const merged = mergeCustomProviders(raw.json, [], [id])
    if (merged.changed) {
      const risk = modelsWriteRisk(raw.json, merged.next, [id])
      if (risk.dropped.length) return { ok: false, errors: [pick(`删除会连带删掉其他服务商（${risk.dropped.join('、')}），已取消`, `Deleting would also remove other providers (${risk.dropped.join(', ')}); cancelled`)] }
      await writeAtomic(merged.next, raw.text)
    }
    return { ok: true, providers: readCustomProviders(merged.next) }
  })
}

function describeFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : ''
  return detail ? `${message}（${detail}）` : message
}

export function modelsEndpoint(baseUrl: string, suffix = 'models'): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`
  url.hash = ''
  return url.href
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(modelsEndpoint(left)).origin === new URL(modelsEndpoint(right)).origin
  } catch {
    return false
  }
}

export function providerAuthHeaders(api: string | undefined, apiKey: string, ...configured: unknown[]): Headers {
  const headers = new Headers()
  if (api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')
  const key = resolveNativeConfigValue(apiKey.trim())?.trim()
  if (key && !/[^\x20-\x7e]/.test(key)) {
    if (api === 'anthropic-messages') headers.set('x-api-key', key)
    else if (api === 'google-generative-ai') headers.set('x-goog-api-key', key)
    else headers.set('Authorization', `Bearer ${key}`)
  }
  for (const block of configured) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, value] of Object.entries(block)) {
      if (typeof value !== 'string' || /^(?:host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(name)) continue
      const resolved = resolveNativeConfigValue(value.trim())
      if (!resolved) continue
      try {
        headers.set(name, resolved)
      } catch {
        continue
      }
    }
  }
  return headers
}

export function fetchProviderModels(url: string, headers: Headers, signal: AbortSignal): Promise<Response> {
  return fetch(url, { headers, signal, redirect: 'manual' })
}

async function fetchModelsPage(
  api: string | undefined,
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
  configured?: unknown
): Promise<{ url: string; response: Response; headers: Headers }> {
  const headers = providerAuthHeaders(api, apiKey, configured)
  let url = modelsEndpoint(baseUrl)
  let response = await fetchProviderModels(url, headers, signal)
  if (response.status === 404 && api === 'anthropic-messages' && !/\/v\d+\/*$/.test(new URL(baseUrl).pathname)) {
    await response.body?.cancel()
    url = modelsEndpoint(baseUrl, 'v1/models')
    response = await fetchProviderModels(url, headers, signal)
  }
  return { url, response, headers }
}

export function providerEntry(models: unknown, id: string): Json | undefined {
  const providers = (models as Json | null)?.providers
  if (!providers || typeof providers !== 'object' || !Object.hasOwn(providers, id)) return undefined
  const entry = (providers as Json)[id]
  return entry && typeof entry === 'object' ? (entry as Json) : undefined
}

async function readProviderEntry(id: string): Promise<Json | undefined> {
  const raw = await readRaw()
  return raw.ok ? providerEntry(raw.json, id) : undefined
}

export function modelProbeHeaders(baseUrl: string, entry: Json | undefined, modelId?: string): Headers {
  const model = modelId && Array.isArray(entry?.models)
    ? entry.models.find((item): item is Json => !!item && typeof item === 'object' && item.id === modelId)
    : undefined
  const inheritsAuth = typeof entry?.baseUrl === 'string' && sameOrigin(entry.baseUrl, baseUrl)
  const api = model?.api ?? entry?.api
  const key = model?.apiKey ?? (inheritsAuth ? entry?.apiKey : undefined)
  return providerAuthHeaders(typeof api === 'string' ? api : undefined, typeof key === 'string' ? key : '',
    inheritsAuth ? entry?.headers : undefined, model?.headers)
}

export async function testCustomProviderEndpoint(id: string): Promise<CustomProviderTestResult> {
  const started = Date.now()
  const entry = await readProviderEntry(id)
  if (!entry) return { ok: false, mode: 'endpoint', ms: 0, message: pick('这个服务不在 models.json 里', 'This service is not in models.json') }
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : ''
  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : ''
  const api = typeof entry.api === 'string' ? entry.api : undefined
  if (!baseUrl) return { ok: false, mode: 'endpoint', ms: 0, message: pick('这条服务没有 Base URL', 'This service has no Base URL') }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const { response } = await fetchModelsPage(api, baseUrl, apiKey, controller.signal, entry.headers)
    const ms = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { ok: false, mode: 'endpoint', ms, message: pick(`凭证被拒绝（HTTP ${response.status}）`, `Credentials rejected (HTTP ${response.status})`) }
    }
    if (response.status === 404) {
      return { ok: false, mode: 'endpoint', ms, message: pick(`地址可达，但端点没有模型列表（HTTP 404）`, `Reachable, but the endpoint has no model list (HTTP 404)`) }
    }
    if (!response.ok) {
      return { ok: false, mode: 'endpoint', ms, message: pick(`端点返回 HTTP ${response.status}`, `Endpoint returned HTTP ${response.status}`) }
    }
    if (!parseModelEntries(await response.json().catch(() => null)).length) {
      return { ok: false, mode: 'endpoint', ms, message: pick('地址可达，但没有返回可识别的模型列表', 'Reachable, but no recognizable model list was returned') }
    }
    return { ok: true, mode: 'endpoint', ms, message: pick(`地址可达，模型列表可用（HTTP ${response.status}）`, `Reachable, model list available (HTTP ${response.status})`) }
  } catch (error) {
    const ms = Date.now() - started
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      mode: 'endpoint',
      ms,
      message: aborted ? pick('连接超时（10 秒）', 'Connection timed out (10 s)') : pick(`连不上：${describeFetchError(error)}`, `Could not connect: ${describeFetchError(error)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function testCustomProviderBillable(opts: {
  id: string
  modelId: string
  piBin: string
}): Promise<CustomProviderTestResult> {
  const started = Date.now()
  const entry = await readProviderEntry(opts.id)
  if (!entry) return { ok: false, mode: 'billable', ms: 0, message: pick('这个服务不在 models.json 里', 'This service is not in models.json') }
  if (!opts.modelId) return { ok: false, mode: 'billable', ms: 0, message: pick('先填一个模型 ID，再发真实请求', 'Enter a model ID before sending a real request') }
  if (!opts.piBin) {
    return { ok: false, mode: 'billable', ms: 0, message: pick('找不到 pi 可执行文件，无法发真实请求', 'pi executable not found; cannot send a real request') }
  }

  const { spawn } = await import('node:child_process')
  return await new Promise<CustomProviderTestResult>((resolve) => {
    const child = spawn(
      opts.piBin,
      [
        '--print',
        '--no-session',
        '--model',
        `${opts.id}/${opts.modelId}`,
        '只回复两个字：收到'
      ],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR },
        windowsHide: true
      }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        mode: 'billable',
        ms: Date.now() - started,
        message: pick('真实请求超时（60 秒）', 'Real request timed out (60 s)')
      })
    }, 60_000)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, mode: 'billable', ms: Date.now() - started, message: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      const text = stdout.trim()
      if (code === 0 && text) return resolve({ ok: true, mode: 'billable', ms, message: pick('真实请求成功', 'Real request succeeded'), text })
      const reason = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? pick(`退出码 ${code}`, `Exit code ${code}`)
      resolve({ ok: false, mode: 'billable', ms, message: reason.slice(0, 200) })
    })
  })
}

export async function discoverCustomProviderModels(input: {
  id?: string
  api?: string
  baseUrl?: string
  apiKey?: string
}): Promise<CustomProviderDiscoverResult> {
  const baseUrl = (input.baseUrl ?? '').trim()
  const urlError = validateBaseUrl(baseUrl)
  if (urlError) return { ok: false, models: [], message: urlError }
  let apiKey = (input.apiKey ?? '').trim()
  const entry = input.id ? await readProviderEntry(input.id) : undefined
  const inheritsAuth = typeof entry?.baseUrl === 'string' && sameOrigin(entry.baseUrl, baseUrl)
  if (!apiKey && typeof entry?.apiKey === 'string') {
    if (!inheritsAuth) return { ok: false, models: [], message: pick('服务地址已更改，请重新输入 API Key 后再获取模型', 'The service address changed; enter the API key again before fetching models') }
    apiKey = entry.apiKey
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const { url, response, headers } = await fetchModelsPage(input.api, baseUrl, apiKey, controller.signal, inheritsAuth ? entry?.headers : undefined)
    if (response.status === 401 || response.status === 403) {
      return { ok: false, models: [], message: pick(`凭证被拒绝（HTTP ${response.status}），先检查 API Key`, `Credentials rejected (HTTP ${response.status}); check the API key`) }
    }
    if (!response.ok) {
      return { ok: false, models: [], message: pick(`这个端点没有提供模型列表（HTTP ${response.status}），请手动填写模型 ID`, `This endpoint has no model list (HTTP ${response.status}); enter the model ID manually`) }
    }
    let body = (await response.json().catch(() => null)) as { nextPageToken?: unknown } | null
    const found: DiscoveredModel[] = parseModelEntries(body)
    for (let page = 0; page < 10 && input.api === 'google-generative-ai' && typeof body?.nextPageToken === 'string' && body.nextPageToken; page++) {
      const nextUrl = new URL(url)
      nextUrl.searchParams.set('pageToken', body.nextPageToken)
      const next = await fetchProviderModels(nextUrl.href, headers, controller.signal)
      if (!next.ok) break
      body = (await next.json().catch(() => null)) as { nextPageToken?: unknown } | null
      for (const model of parseModelEntries(body)) if (!found.some((m) => m.id === model.id)) found.push(model)
    }
    if (!found.length) return { ok: false, models: [], message: pick('端点返回了空列表，请手动填写模型 ID', 'The endpoint returned an empty list; enter the model ID manually') }
    const entries = describeDiscoveredModels(found, { api: input.api ?? 'openai-completions', baseUrl }, await readPiModelCatalog())
    const thinking = entries.filter((m) => m.reasoning).length
    return {
      ok: true,
      models: entries.map((m) => m.id),
      entries,
      message: pick(`获取到 ${entries.length} 个模型，其中 ${thinking} 个支持思考`, `Fetched ${entries.length} models, ${thinking} with thinking support`)
    }
  } catch (error) {
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      models: [],
      message: aborted ? pick('获取超时（10 秒）', 'Fetch timed out (10 s)') : pick(`连不上：${describeFetchError(error)}`, `Could not connect: ${describeFetchError(error)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
