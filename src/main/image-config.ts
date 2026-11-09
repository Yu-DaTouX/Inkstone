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

let current: ImageConfigFile = {}
let chain: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
}

function sanitize(raw: unknown): ImageConfigFile {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: ImageConfigFile = {}
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
  return out
}

async function readFileConfig(): Promise<ImageConfigFile> {
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
  return current.keys?.[service]
}

async function update(change: (file: ImageConfigFile) => ImageConfigFile): Promise<{ ok: boolean; error?: string }> {
  try {
    await serial(async () => {
      const next = sanitize(change(await readFileConfig()))
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
  return update((file) => ({ ...file, keys: { ...file.keys, [service]: value } }))
}

export function clearImageKey(service: ImageKeyService): Promise<{ ok: boolean; error?: string }> {
  return update((file) => {
    const keys = { ...file.keys }
    delete keys[service]
    return { ...file, keys }
  })
}
