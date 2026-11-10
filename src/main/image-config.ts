import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pick } from '../shared/ui-lang'
import { IMAGE_COMPLEXITIES, IMAGE_KEY_SERVICES, IMAGE_MODEL_SERVICES, isImageChoice, type ImageConfigFile, type ImageConfigPatch, type ImageKeyService } from '../shared/image-config'
import { YAN_DIR } from './paths'
import { atomicWriteFile } from './sync/atomic'

const CONFIG_FILE = (): string => join(YAN_DIR, 'image-config.json')

const MODEL_ENV = {
  compatible: 'YAN_IMAGE_COMPATIBLE_MODEL',
  openai: 'YAN_IMAGE_OPENAI_MODEL',
  google: 'YAN_IMAGE_GOOGLE_MODEL',
  doubao: 'YAN_IMAGE_DOUBAO_MODEL'
} as const

type StoredImageConfig = ImageConfigFile & { keyEndpoints?: Partial<Record<ImageKeyService, string>> }

let current: StoredImageConfig = {}
let chain: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
}

export function normalizeImageEndpoint(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `!${raw}`
  }
  if (url.username || url.password || url.hash) return `!${raw}`
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`
}

function endpointIssue(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return pick('接口地址无效', 'The endpoint is not a valid URL')
  }
  if (url.username || url.password) return pick('接口地址不能带账号或密码', 'The endpoint must not include credentials')
  if (url.search) return pick('接口地址不能带查询参数', 'The endpoint must not include a query string')
  if (url.hash) return pick('接口地址不能带 # 片段', 'The endpoint must not include a # fragment')
  return undefined
}

function effectiveCompatibleBase(file: ImageConfigFile): string | undefined {
  return file.baseUrl?.trim() || process.env.YAN_IMAGE_API_BASE?.trim() || undefined
}

function sanitize(raw: unknown): StoredImageConfig {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: StoredImageConfig = {}
  if (isImageChoice(input.provider) && input.provider !== 'auto') out.provider = input.provider
  if ((IMAGE_COMPLEXITIES as readonly unknown[]).includes(input.complexity)) out.complexity = input.complexity as ImageConfigFile['complexity']
  const baseUrl = text(input.baseUrl, 2048)
  if (baseUrl) out.baseUrl = baseUrl
  const models: NonNullable<ImageConfigFile['models']> = {}
  const rawModels = input.models && typeof input.models === 'object' ? (input.models as Record<string, unknown>) : {}
  for (const service of IMAGE_MODEL_SERVICES) {
    const value = text(rawModels[service], 200)
    if (value) models[service] = value
  }
  if (Object.keys(models).length) out.models = models
  const keys: NonNullable<ImageConfigFile['keys']> = {}
  const rawKeys = input.keys && typeof input.keys === 'object' ? (input.keys as Record<string, unknown>) : {}
  for (const service of IMAGE_KEY_SERVICES) {
    const value = text(rawKeys[service], 4096)
    if (value) keys[service] = value
  }
  if (Object.keys(keys).length) out.keys = keys
  const endpoints: NonNullable<StoredImageConfig['keyEndpoints']> = {}
  const rawEndpoints = input.keyEndpoints && typeof input.keyEndpoints === 'object' ? (input.keyEndpoints as Record<string, unknown>) : {}
  for (const service of IMAGE_KEY_SERVICES) {
    const value = text(rawEndpoints[service], 2048)
    if (value) endpoints[service] = value
  }
  if (Object.keys(endpoints).length) out.keyEndpoints = endpoints
  return out
}

async function readFileConfig(): Promise<StoredImageConfig> {
  try {
    return sanitize(JSON.parse(await readFile(CONFIG_FILE(), 'utf8')))
  } catch {
    return {}
  }
}

export async function refreshImageConfig(): Promise<ImageConfigFile> {
  current = await readFileConfig()
  return current
}

export function imageConfigSnapshot(): ImageConfigFile {
  return current
}

export function imageEnv(name: string): string | undefined {
  let override: string | undefined
  if (name === 'YAN_IMAGE_PROVIDER') override = current.provider
  else if (name === 'YAN_IMAGE_API_BASE') override = current.baseUrl
  else for (const [service, envName] of Object.entries(MODEL_ENV)) if (envName === name) override = current.models?.[service as keyof typeof MODEL_ENV]
  return override || process.env[name]?.trim() || undefined
}

export function imageComplexity(): ImageConfigFile['complexity'] {
  return current.complexity
}

export function imageFileKey(service: ImageKeyService): string | undefined {
  const key = current.keys?.[service]
  if (!key) return undefined
  if (service === 'compatible') {
    const bound = current.keyEndpoints?.compatible
    if (bound && bound !== normalizeImageEndpoint(effectiveCompatibleBase(current))) return undefined
  }
  return key
}

function withoutCompatibleBinding(file: StoredImageConfig): StoredImageConfig {
  const keys = { ...file.keys }
  delete keys.compatible
  const keyEndpoints = { ...file.keyEndpoints }
  delete keyEndpoints.compatible
  return { ...file, keys, keyEndpoints }
}

async function update(change: (file: StoredImageConfig) => StoredImageConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await serial(async () => {
      const file = await readFileConfig()
      const changed = change(file)
      const baseChanged = normalizeImageEndpoint(effectiveCompatibleBase(file)) !== normalizeImageEndpoint(effectiveCompatibleBase(changed))
      const next = sanitize(baseChanged ? withoutCompatibleBinding(changed) : changed)
      await atomicWriteFile(CONFIG_FILE(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      current = next
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : pick('写入失败', 'Write failed') }
  }
}

export function updateImageConfig(patch: ImageConfigPatch): Promise<{ ok: boolean; error?: string }> {
  return update((file) => {
    const next: ImageConfigFile = { ...file }
    if (patch.provider !== undefined) {
      if (patch.provider === 'auto') delete next.provider
      else if (isImageChoice(patch.provider)) next.provider = patch.provider
    }
    if (patch.complexity !== undefined) {
      if (patch.complexity === 'default') delete next.complexity
      else if ((IMAGE_COMPLEXITIES as readonly unknown[]).includes(patch.complexity)) next.complexity = patch.complexity
    }
    if (patch.baseUrl !== undefined) {
      const value = patch.baseUrl.trim()
      if (value && !/^https?:\/\//i.test(value)) throw new Error(pick('接口地址需要以 http:// 或 https:// 开头', 'The endpoint must start with http:// or https://'))
      const issue = value ? endpointIssue(value) : undefined
      if (issue) throw new Error(issue)
      if (value) next.baseUrl = value
      else delete next.baseUrl
    }
    if (patch.model && (IMAGE_MODEL_SERVICES as readonly string[]).includes(patch.model.service)) {
      const models = { ...file.models }
      const value = patch.model.value.trim()
      if (value) models[patch.model.service] = value
      else delete models[patch.model.service]
      next.models = models
    }
    return next
  })
}

export function setImageKey(service: ImageKeyService, key: string): Promise<{ ok: boolean; error?: string }> {
  const value = key.trim()
  if (!(IMAGE_KEY_SERVICES as readonly string[]).includes(service)) return Promise.resolve({ ok: false, error: pick('不认识的生图服务', 'Unknown image service') })
  if (!value) return Promise.resolve({ ok: false, error: pick('API key 不能为空', 'API key cannot be empty') })
  if (/\s/.test(value)) return Promise.resolve({ ok: false, error: pick('API key 不应包含空白字符', 'API key must not contain whitespace') })
  return update((file) => {
    const keyEndpoints = { ...file.keyEndpoints }
    if (service === 'compatible') {
      const endpoint = normalizeImageEndpoint(effectiveCompatibleBase(file))
      if (endpoint) keyEndpoints.compatible = endpoint
      else delete keyEndpoints.compatible
    }
    return { ...file, keys: { ...file.keys, [service]: value }, keyEndpoints }
  })
}

export function clearImageKey(service: ImageKeyService): Promise<{ ok: boolean; error?: string }> {
  return update((file) => {
    const keys = { ...file.keys }
    delete keys[service]
    const keyEndpoints = { ...file.keyEndpoints }
    delete keyEndpoints[service]
    return { ...file, keys, keyEndpoints }
  })
}
