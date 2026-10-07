/*
 * 砚内置「Command Code」服务扩展 —— 让在「接入」页填了 Command Code 密钥的用户直接有模型可用。
 *
 * pi 本身不认识 Command Code：以前只有手写 models.json 的用户能用，而且手写的列表
 * 不知道哪些模型能思考（多数模型没有思考档位）、也不知道 Claude 只开放 Anthropic 接口。
 * 这里在 pi 启动时注册 `commandcode` 服务：
 *   · 模型列表来自 Command Code 的公开 /models（不需要密钥），
 *     能否思考、单模型协议、输出上限按 src/shared/custom-provider.ts 的同一套规则补齐；
 *   · 密钥由 pi 按服务名从 auth.json 取（砚的凭证页写的就是这一项），本扩展不碰密钥；
 *   · 上一次拉到的列表缓存在 pi 目录，下次启动先用缓存、后台再刷新，不拖慢启动。
 *
 * ── 边界 ──
 *   · 没有 Command Code 凭证的用户什么也不做（不联网）；
 *   · 用户自己在 models.json 里写了 `commandcode` 时让位，不覆盖手写配置；
 *   · 拉取失败只静默沿用缓存，不影响其它服务。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeDiscoveredModels, parseModelEntries } from './generated/model-capabilities.mjs'

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

/** 用户配了 Command Code：凭证页写进 auth.json 的那一项，或环境变量 */
export function hasCredential(dir, env = process.env) {
  return !!env.COMMANDCODE_API_KEY || !!readJson(join(dir, 'auth.json'))?.[PROVIDER]
}

/** 用户自己在 models.json 里定义了 commandcode：以手写为准 */
export function handWritten(dir) {
  return !!readJson(join(dir, 'models.json'))?.providers?.[PROVIDER]
}

/** 砚的模型条目 → pi 注册所需的完整模型定义（pi 要求名称、输入、费用、上下文与输出上限齐全） */
export function toPiModels(entries) {
  return entries.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...(m.api ? { api: m.api } : {}),
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    reasoning: m.reasoning === true,
    ...(m.reasoning && m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    input: m.input ?? ['text'],
    /* 订阅制按额度窗口计费，没有逐 token 价格 */
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    /* 缓存写不进去只影响下次启动速度 */
  }
}

export default async function commandcodeExtension(pi) {
  const dir = agentDir()
  if (!hasCredential(dir) || handWritten(dir)) return
  const catalog = readJson(join(here, 'generated', 'pi-model-catalog.json'))?.models ?? {}
  const cachePath = join(dir, CACHE_FILE)
  const register = (entries) =>
    pi.registerProvider(PROVIDER, { name: 'Command Code', baseUrl: BASE_URL, api: 'openai-completions', models: toPiModels(entries) })
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
