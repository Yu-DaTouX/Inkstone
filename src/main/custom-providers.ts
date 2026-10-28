import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import {
  describeDiscoveredModels,
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
  type CustomProviderView
} from '../shared/custom-provider'
import { readPiModelCatalog } from './pi-model-catalog'

export const MODELS_FILE = join(PI_AGENT_DIR, 'models.json')
const AUTO_BACKUP_PREFIX = 'models.json.bak-yan-auto-'
const AUTO_BACKUP_KEEP = 5

export interface CustomProviderResult {
  ok: boolean
  errors?: string[]
  providers?: CustomProviderView[]
}

type Json = Record<string, unknown>

async function readRaw(): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const text = await readFile(MODELS_FILE, 'utf8')
    try {
      return { ok: true, json: JSON.parse(text) }
    } catch {
      return { ok: false, error: `models.json 不是合法 JSON，先修好再保存：${MODELS_FILE}` }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, json: {} }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let modelsWriteChain: Promise<unknown> = Promise.resolve()
function serializeModels<T>(work: () => Promise<T>): Promise<T> {
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

async function writeAtomic(json: Json): Promise<void> {
  await mkdir(PI_AGENT_DIR, { recursive: true })
  await backupModels()
  const tmp = `${MODELS_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, MODELS_FILE)
  } catch (error) {
    const { unlink } = await import('node:fs/promises')
    await unlink(tmp).catch(() => undefined)
    throw error
  }
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
      if (risk.dropped.length) return { ok: false, errors: [`保存会删掉其他服务商（${risk.dropped.join('、')}），已取消`] }
      if (risk.shrink.length && !input.confirmShrink) return { ok: false, shrink: risk.shrink, errors: risk.shrink.map((item) => `${item.provider} 的模型会从 ${item.before} 个减少到 ${item.after} 个，需要确认`) }
      await writeAtomic(merged.next)
    }
    return { ok: true, providers: readCustomProviders(merged.next) }
  })
}

export async function removeCustomProvider(id: string): Promise<CustomProviderResult> {
  return serializeModels(async () => {
    const raw = await readRaw()
    if (!raw.ok) return { ok: false, errors: [raw.error] }
    const merged = mergeCustomProviders(raw.json, [], [id])
    if (merged.changed) {
      const risk = modelsWriteRisk(raw.json, merged.next, [id])
      if (risk.dropped.length) return { ok: false, errors: [`删除会连带删掉其他服务商（${risk.dropped.join('、')}），已取消`] }
      await writeAtomic(merged.next)
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

export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`
}

function providerAuthHeaders(api: string | undefined, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!apiKey) return headers
  if (api === 'anthropic-messages') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (api === 'google-generative-ai') {
    headers['x-goog-api-key'] = apiKey
  } else {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

async function fetchModelsPage(
  api: string | undefined,
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<{ url: string; response: Response; headers: Record<string, string> }> {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '')
  const headers = providerAuthHeaders(api, apiKey)
  let url = modelsEndpoint(trimmedBase)
  let response = await fetch(url, { headers, signal })
  if (response.status === 404 && api === 'anthropic-messages' && !/\/v\d+$/.test(trimmedBase)) {
    url = modelsEndpoint(`${trimmedBase}/v1`)
    response = await fetch(url, { headers, signal })
  }
  return { url, response, headers }
}

async function readProviderEntry(id: string): Promise<Json | null> {
  const raw = await readRaw()
  if (!raw.ok) return null
  const providers = (raw.json as Json)?.providers
  if (!providers || typeof providers !== 'object') return null
  const entry = (providers as Json)[id]
  return entry && typeof entry === 'object' ? (entry as Json) : null
}

export async function testCustomProviderEndpoint(id: string): Promise<CustomProviderTestResult> {
  const started = Date.now()
  const entry = await readProviderEntry(id)
  if (!entry) return { ok: false, mode: 'endpoint', ms: 0, message: '这个服务不在 models.json 里' }
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : ''
  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : ''
  const api = typeof entry.api === 'string' ? entry.api : undefined
  if (!baseUrl) return { ok: false, mode: 'endpoint', ms: 0, message: '这条服务没有 Base URL' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const { response } = await fetchModelsPage(api, baseUrl, apiKey, controller.signal)
    const ms = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { ok: false, mode: 'endpoint', ms, message: `凭证被拒绝（HTTP ${response.status}）` }
    }
    if (response.status === 404) {
      return { ok: false, mode: 'endpoint', ms, message: `地址可达，但端点没有模型列表（HTTP 404）` }
    }
    if (!response.ok) {
      return { ok: false, mode: 'endpoint', ms, message: `端点返回 HTTP ${response.status}` }
    }
    await response.arrayBuffer()
    return { ok: true, mode: 'endpoint', ms, message: `地址可达，凭证可用（HTTP ${response.status}）` }
  } catch (error) {
    const ms = Date.now() - started
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      mode: 'endpoint',
      ms,
      message: aborted ? '连接超时（10 秒）' : `连不上：${describeFetchError(error)}`
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
  if (!entry) return { ok: false, mode: 'billable', ms: 0, message: '这个服务不在 models.json 里' }
  if (!opts.modelId) return { ok: false, mode: 'billable', ms: 0, message: '先填一个模型 ID，再发真实请求' }
  if (!opts.piBin) {
    return { ok: false, mode: 'billable', ms: 0, message: '找不到 pi 可执行文件，无法发真实请求' }
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
        message: '真实请求超时（60 秒）'
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
      if (code === 0 && text) return resolve({ ok: true, mode: 'billable', ms, message: '真实请求成功', text })
      const reason = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `退出码 ${code}`
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
  if (!apiKey && input.id) {
    const entry = await readProviderEntry(input.id)
    if (entry && typeof entry.apiKey === 'string' && typeof entry.baseUrl === 'string' && entry.baseUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '')) {
      apiKey = entry.apiKey
    } else if (entry && typeof entry.apiKey === 'string') {
      return { ok: false, models: [], message: '服务地址已更改，请重新输入 API Key 后再获取模型' }
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const { url, response, headers } = await fetchModelsPage(input.api, baseUrl, apiKey, controller.signal)
    if (response.status === 401 || response.status === 403) {
      return { ok: false, models: [], message: `凭证被拒绝（HTTP ${response.status}），先检查 API Key` }
    }
    if (!response.ok) {
      return { ok: false, models: [], message: `这个端点没有提供模型列表（HTTP ${response.status}），请手动填写模型 ID` }
    }
    let body = (await response.json().catch(() => null)) as { nextPageToken?: unknown } | null
    const found: DiscoveredModel[] = parseModelEntries(body)
    for (let page = 0; page < 10 && input.api === 'google-generative-ai' && typeof body?.nextPageToken === 'string' && body.nextPageToken; page++) {
      const next = await fetch(`${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(body.nextPageToken)}`, { headers, signal: controller.signal })
      if (!next.ok) break
      body = (await next.json().catch(() => null)) as { nextPageToken?: unknown } | null
      for (const model of parseModelEntries(body)) if (!found.some((m) => m.id === model.id)) found.push(model)
    }
    if (!found.length) return { ok: false, models: [], message: '端点返回了空列表，请手动填写模型 ID' }
    const entries = describeDiscoveredModels(found, { api: input.api ?? 'openai-completions', baseUrl }, await readPiModelCatalog())
    const thinking = entries.filter((m) => m.reasoning).length
    return {
      ok: true,
      models: entries.map((m) => m.id),
      entries,
      message: `获取到 ${entries.length} 个模型，其中 ${thinking} 个支持思考`
    }
  } catch (error) {
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      models: [],
      message: aborted ? '获取超时（10 秒）' : `连不上：${describeFetchError(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
