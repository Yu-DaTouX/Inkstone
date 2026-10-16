import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogKey, cleanModelCost, describeDiscoveredModels, parseModelEntries } from './generated/model-capabilities.mjs'

export const PROVIDER = 'commandcode'
export const BASE_URL = 'https://api.commandcode.ai/provider/v1'
const CACHE_FILE = 'yan-commandcode-models.json'
const FETCH_TIMEOUT_MS = 8000
const here = dirname(fileURLToPath(import.meta.url))

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function agentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

export function hasCredential(dir, env = process.env) {
  return !!env.COMMANDCODE_API_KEY || !!readJson(join(dir, 'auth.json'))?.[PROVIDER]
}

export function handWritten(dir) {
  return !!readJson(join(dir, 'models.json'))?.providers?.[PROVIDER]
}

export function toPiModels(entries, catalog = {}) {
  return entries.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...(m.api ? { api: m.api } : {}),
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    reasoning: m.reasoning === true,
    ...(m.reasoning && m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    input: m.input ?? ['text'],
    cost: cleanModelCost(m.cost) ?? cleanModelCost(catalog[catalogKey(m.id)]?.cost) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 16384
  }))
}

export async function fetchModels(catalog, fetchImpl = fetch) {
  const response = await fetchImpl(`${BASE_URL}/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const found = parseModelEntries(await response.json())
  return describeDiscoveredModels(found, { api: 'openai-completions', baseUrl: BASE_URL }, catalog)
}

function writeCache(path, models) {
  try {
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), models }))
    renameSync(tmp, path)
  } catch {
  }
}

export default async function commandcodeExtension(pi) {
  const dir = agentDir()
  if (!hasCredential(dir) || handWritten(dir)) return
  const catalog = readJson(join(here, 'generated', 'pi-model-catalog.json'))?.models ?? {}
  const cachePath = join(dir, CACHE_FILE)
  const register = (entries) =>
    pi.registerProvider(PROVIDER, {
      name: 'Command Code',
      baseUrl: BASE_URL,
      api: 'openai-completions',
      ...(process.env.COMMANDCODE_API_KEY ? { apiKey: '$COMMANDCODE_API_KEY' } : {}),
      models: toPiModels(entries, catalog)
    })
  const refresh = async () => {
    const entries = await fetchModels(catalog)
    if (!entries.length) return false
    register(entries)
    writeCache(cachePath, entries)
    return true
  }

  const cached = existsSync(cachePath) ? readJson(cachePath)?.models : undefined
  if (Array.isArray(cached) && cached.length) {
    register(cached)
    void refresh().catch(() => {})
    return
  }
  await refresh().catch(() => {})
}
