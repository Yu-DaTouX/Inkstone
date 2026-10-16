import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { readAuthEntry } from './credentials'

type EnvLike = Record<string, string | undefined>

interface OfficialQuotaEndpoint {
  hosts: readonly string[]
  nativeDefaultBaseUrl?: string
}

const OFFICIAL_ENDPOINTS: Readonly<Record<string, OfficialQuotaEndpoint>> = {
  commandcode: { hosts: ['api.commandcode.ai'] },
  deepseek: { hosts: ['api.deepseek.com'], nativeDefaultBaseUrl: 'https://api.deepseek.com' },
  openrouter: { hosts: ['openrouter.ai'], nativeDefaultBaseUrl: 'https://openrouter.ai/api/v1' },
  openai: { hosts: ['api.openai.com'], nativeDefaultBaseUrl: 'https://api.openai.com/v1' }
}

const NATIVE_ENV_NAMES: Readonly<Record<string, string>> = {
  commandcode: 'COMMANDCODE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY'
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function resolveNativeConfigValue(value: string, env: EnvLike = process.env): string | undefined {
  if (value.startsWith('!')) return undefined
  let out = ''
  let index = 0
  while (index < value.length) {
    const dollar = value.indexOf('$', index)
    if (dollar < 0) {
      out += value.slice(index)
      break
    }
    out += value.slice(index, dollar)
    const next = value[dollar + 1]
    if (next === '$' || next === '!') {
      out += next
      index = dollar + 2
      continue
    }
    if (next === '{') {
      const end = value.indexOf('}', dollar + 2)
      if (end < 0) {
        out += '$'
        index = dollar + 1
        continue
      }
      const name = value.slice(dollar + 2, end)
      if (!ENV_NAME_RE.test(name)) {
        out += value.slice(dollar, end + 1)
        index = end + 1
        continue
      }
      const resolved = env[name]
      if (resolved === undefined) return undefined
      out += resolved
      index = end + 1
      continue
    }
    let cursor = dollar + 1
    while (cursor < value.length && /[A-Za-z0-9_]/.test(value[cursor])) cursor++
    const name = value.slice(dollar + 1, cursor)
    if (name && ENV_NAME_RE.test(name)) {
      const resolved = env[name]
      if (resolved === undefined) return undefined
      out += resolved
      index = cursor
      continue
    }
    out += '$'
    index = dollar + 1
  }
  return out
}

function officialLiteralBaseUrlAllowed(provider: string, value: unknown): boolean {
  const official = OFFICIAL_ENDPOINTS[provider]
  if (!official) return false
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw) return false
  if (raw.startsWith('!') || raw.includes('$')) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.port && url.port !== '443') return false
  return official.hosts.includes(url.hostname.toLowerCase())
}

function entryEndpointAllowed(provider: string, entry: unknown): boolean {
  const official = OFFICIAL_ENDPOINTS[provider]
  if (!official) return false
  if (!plainObject(entry)) return false
  const baseUrl = entry.baseUrl
  const missingBase = baseUrl === undefined || baseUrl === null || (typeof baseUrl === 'string' && !baseUrl.trim())
  if (missingBase) {
    if (!official.nativeDefaultBaseUrl) return false
  } else if (!officialLiteralBaseUrlAllowed(provider, baseUrl)) {
    return false
  }
  const models = entry.models
  if (models !== undefined) {
    if (!Array.isArray(models)) return false
    for (const model of models) {
      if (!plainObject(model)) return false
      const modelBase = model.baseUrl
      if (modelBase === undefined || modelBase === null) continue
      if (!officialLiteralBaseUrlAllowed(provider, modelBase)) return false
    }
  }
  return true
}

export function extractModelsJsonQuotaKey(
  provider: string,
  entry: unknown,
  env: EnvLike = process.env
): string | undefined {
  const id = provider.trim().toLowerCase()
  if (!OFFICIAL_ENDPOINTS[id]) return undefined
  if (!entryEndpointAllowed(id, entry)) return undefined
  const apiKey = (entry as Record<string, unknown>).apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim()) return undefined
  const resolved = resolveNativeConfigValue(apiKey, env)
  return resolved && resolved.trim() ? resolved : undefined
}

export async function readModelsJsonQuotaKey(
  provider: string,
  options: { agentDir?: string; env?: EnvLike } = {}
): Promise<string | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(options.agentDir ?? PI_AGENT_DIR, 'models.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (!plainObject(parsed)) return undefined
  const providers = parsed.providers
  if (!plainObject(providers)) return undefined
  const id = provider.trim().toLowerCase()
  return extractModelsJsonQuotaKey(id, providers[id], options.env ?? process.env)
}

type ModelsEntryLookup =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'entry'; entry: unknown }

async function readModelsEntry(provider: string, agentDir?: string): Promise<ModelsEntryLookup> {
  let raw: string
  try {
    raw = await readFile(join(agentDir ?? PI_AGENT_DIR, 'models.json'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }
  if (!plainObject(parsed)) return { kind: 'invalid' }
  const providers = parsed.providers
  if (providers === undefined) return { kind: 'absent' }
  if (!plainObject(providers)) return { kind: 'invalid' }
  if (!(provider in providers)) return { kind: 'absent' }
  const entry = providers[provider]
  if (!plainObject(entry)) return { kind: 'invalid' }
  return { kind: 'entry', entry }
}

async function readAuthKey(
  provider: string,
  options: { readAuth?: (provider: string) => Promise<unknown> }
): Promise<string | undefined> {
  let entry: unknown
  try {
    entry = await (options.readAuth ?? readAuthEntry)(provider)
  } catch {
    return undefined
  }
  if (typeof entry === 'string') return entry.trim() ? entry : undefined
  if (!plainObject(entry)) return undefined
  for (const field of ['key', 'access', 'access_token'] as const) {
    const value = entry[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function readNativeEnv(provider: string, env: EnvLike): string | undefined {
  const name = NATIVE_ENV_NAMES[provider]
  if (!name) return undefined
  const value = env[name]
  return typeof value === 'string' && value.trim() ? value : undefined
}

export async function resolveQuotaProviderSecret(
  rawProvider: string,
  options: {
    agentDir?: string
    env?: EnvLike
    readAuth?: (provider: string) => Promise<unknown>
  } = {}
): Promise<string | undefined> {
  const provider = rawProvider.trim().toLowerCase()
  if (!provider || !OFFICIAL_ENDPOINTS[provider]) return undefined
  const env = options.env ?? process.env

  const lookup = await readModelsEntry(provider, options.agentDir)
  if (lookup.kind === 'invalid') return undefined
  let entry: Record<string, unknown> | undefined
  if (lookup.kind === 'entry') {
    if (!entryEndpointAllowed(provider, lookup.entry)) return undefined
    entry = lookup.entry as Record<string, unknown>
  }

  const fromAuth = await readAuthKey(provider, options)
  if (fromAuth) return fromAuth

  if (entry) {
    const rawApiKey = entry.apiKey
    if (rawApiKey !== undefined && rawApiKey !== null) {
      if (typeof rawApiKey !== 'string' || !rawApiKey.trim()) return undefined
      const resolved = resolveNativeConfigValue(rawApiKey, env)
      return resolved && resolved.trim() ? resolved : undefined
    }
    if (!OFFICIAL_ENDPOINTS[provider].nativeDefaultBaseUrl) return undefined
  }

  return readNativeEnv(provider, env)
}
