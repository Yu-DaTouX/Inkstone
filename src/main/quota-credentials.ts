/**
 * 额度查询取 key 的统一来源 —— 状态栏额度与「账号额度」磁贴共用同一份。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个模块
 * ══════════════════════════════════════════════════════════════════
 * 砚的凭证页把 API key 写进 `auth.json`，`resolveProviderSecret` 读它并回退到
 * 环境变量。但 pi 原生还认 `<agent dir>/models.json` 里 `providers.<id>.apiKey`：
 *
 *   `configuredApiKey(config, extension) = extension?.apiKey ?? config?.apiKey`
 *
 * （`config` 即 models.json 的 provider 条目，见随包 runtime 的
 * `composeApiKeyAuth`）。只把 key 写在 models.json 里的用户，额度接口拿不到
 * key，卡就会整张消失 —— 这条来源必须补上，而且两个额度入口要用同一份口径。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序与安全边界
 * ══════════════════════════════════════════════════════════════════
 * **先核对生效端点，再选 key 来源。** 顺序与 pi 原生一致：
 * `auth.json` > `models.json` 的 apiKey > 内置环境变量（原生
 * `composeApiKeyAuth.resolve`：`input.credential` > `rawKey` > `inherited`）。
 *
 * ⚠️ 这里修的是一个真实漏洞：只看「key 从哪来」是不够的。若 models.json 把
 * `providers.commandcode.baseUrl` 指到代理，那么用户存进 auth.json / 环境变量的
 * 往往就是**那把代理 key**；先前「auth/env 先返回、再校验 models 端点」的写法会
 * 把这把代理 key 发给官方额度接口。所以现在只要 provider 在 models.json 里存在
 * 条目，就先核对生效端点：
 *   · 条目非官方 / 坏 JSON / 形状不可信 → 三个来源（auth / env / models）一律不取；
 *   · 生效 baseUrl 必须是官方 HTTPS 主机、默认端口、URL 不带用户凭证，且不是
 *     配置值模板 / 命令（`$` / `!`），否则端点不可证明 → 一律不取；
 *   · 条目里的 per-model `baseUrl` 原生会实际用于该模型请求，任何一条指离官方
 *     也判为不可证明 → 一律不取（未知不能拿官方 API 去试 key）；
 *   · 条目缺 baseUrl 时，只有能证明原生会落到官方默认 baseUrl 的内置 provider
 *     才放行（deepseek / openrouter / openai）；commandcode 由随包扩展提供、
 *     扩展在 models.json 有条目时让位，没有原生默认 → 缺 baseUrl 不认。
 *
 * 没有 models.json 条目时按 `canProveNativeDefault` 放行：auth-only / env-only
 * 用户保持原样。key 来源本身（`resolveNativeConfigValue`）与原生
 * `parseConfigValueTemplate` 同规则：只认静态字符串与 `$NAME` / `${NAME}`
 * 环境引用，`!` 命令型不读、不执行 —— 本模块不 import 任何 `child_process`。
 *
 * 若 models.json 条目声明了 apiKey（原生 `rawKey`），原生就不再回退到内置 env；
 * 因此该 apiKey 是命令型 / 环境引用缺变量时，本模块如实报「缺凭证」，绝不拿全局
 * 环境变量去冒充另一把 key（那会把另一个账户的数字显示给用户）。
 *
 * key 只在主进程里用来发额度请求，不打印、不跨 IPC、不写日志。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { readAuthEntry } from './credentials'

type EnvLike = Record<string, string | undefined>

/**
 * 官方额度接口的允许主机 + 原生默认 baseUrl。
 *
 * 证据（随包 runtime chunk）：
 *   · `deepseek` / `openrouter` / `openai` 是 pi 内置 provider，各自声明了
 *     baseUrl，所以 models.json 条目缺 baseUrl 时 pi 仍落到官方端点；
 *   · `commandcode` 不是内置 provider，由随包扩展 `registerProvider` 提供，
 *     而扩展在 `models.json` 已有该 provider 时直接让位，不存在原生默认 ——
 *     缺 baseUrl 不认。
 */
interface OfficialQuotaEndpoint {
  /** 允许的主机名（小写比较） */
  hosts: readonly string[]
  /** pi 内置 provider 的官方默认 baseUrl；缺省表示没有可证明的原生默认 */
  nativeDefaultBaseUrl?: string
}

const OFFICIAL_ENDPOINTS: Readonly<Record<string, OfficialQuotaEndpoint>> = {
  commandcode: { hosts: ['api.commandcode.ai'] },
  deepseek: { hosts: ['api.deepseek.com'], nativeDefaultBaseUrl: 'https://api.deepseek.com' },
  openrouter: { hosts: ['openrouter.ai'], nativeDefaultBaseUrl: 'https://openrouter.ai/api/v1' },
  openai: { hosts: ['api.openai.com'], nativeDefaultBaseUrl: 'https://api.openai.com/v1' }
}

/** pi 内置 provider 的环境变量来源（与 `credentials.resolveProviderSecret` 同名）。 */
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

/**
 * 解析 pi 的「配置值」语法（只识别环境引用，**不执行命令**）。
 *
 * 与 runtime `parseConfigValueTemplate` 同规则：
 *   · `!` 开头视为命令 → 这里返回 `undefined`（拒绝，不执行）；
 *   · `$$` / `$!` → 字面量；
 *   · `${NAME}`（NAME 为合法环境变量名）或 `$NAME` → 环境变量引用；
 *   · 引用的环境变量缺失 → 返回 `undefined`（不造凭证）；
 *   · 其余 `$` 视作字面量。
 */
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

/**
 * 一个**字面量** baseUrl 是否满足官方 HTTPS / 主机 / 端口 / 无 URL 凭证约束。
 *
 * 配置值模板（`$`）与命令（`!`）一律判为不可证明 —— 生效端点取决于运行时环境
 * 或 shell，不能据此把 key 发去官方额度接口。
 */
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

/**
 * models.json 的 provider 条目是否「足以证明生效端点是官方」。
 *
 * provider 级 baseUrl 缺省时要求有原生默认；存在时必须通过字面量官方校验。
 * 条目里 per-model 的 baseUrl 原生会实际用于该模型，任何一条指离官方 /
 * 是模板 / 形状不对都判为不可证明。
 */
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

/**
 * 从 models.json 的 provider 条目里取额度用的 key（纯函数，不碰文件）。
 *
 * 非官方 provider / 条目形状不对 / 生效端点不可证明 / 命令型 apiKey /
 * 环境引用缺变量 —— 一律返回 `undefined`，让调用方如实报「缺凭证」，
 * 而不是编一把 key 去发官方请求。
 */
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

/**
 * 读 `<agent dir>/models.json` 里的官方 key 兜底。
 * 文件不存在 / JSON 坏掉 / 没有该 provider —— 都返回 `undefined`。
 */
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

/** models.json 里该 provider 条目状态的判定结果。 */
type ModelsEntryLookup =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'entry'; entry: unknown }

/**
 * 读 models.json 并定位该 provider 条目。
 *
 * `absent` 与 `invalid` 必须分开：文件不存在（或没有该 provider）时按能证明的
 * 原生默认放行；文件读不了 / JSON 坏 / 形状不可信则一律拒绝，不发送任何 key。
 */
async function readModelsEntry(provider: string, agentDir?: string): Promise<ModelsEntryLookup> {
  let raw: string
  try {
    raw = await readFile(join(agentDir ?? PI_AGENT_DIR, 'models.json'), 'utf8')
  } catch (error) {
    /* 文件不存在 = 没有配置；其它读取错误无法证明端点，保守拒绝 */
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

/** 从 auth.json 条目里取 key（与 `resolveProviderSecret` 同一套字段）。 */
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

/** pi 内置 provider 的环境变量来源。 */
function readNativeEnv(provider: string, env: EnvLike): string | undefined {
  const name = NATIVE_ENV_NAMES[provider]
  if (!name) return undefined
  const value = env[name]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * 额度查询统一的取 key：先核对生效端点，再按原生顺序
 * `auth.json` > `models.json` apiKey > 内置环境变量 取 key。
 *
 * `options.readAuth` / `options.env` 仅测试注入（明确区分 auth 与 env 来源，
 * 不从一个合并的 resolveSecret 里猜来源）。
 */
export async function resolveQuotaProviderSecret(
  rawProvider: string,
  options: {
    agentDir?: string
    env?: EnvLike
    /** 仅测试注入：auth.json 条目；正常走 `readAuthEntry` */
    readAuth?: (provider: string) => Promise<unknown>
  } = {}
): Promise<string | undefined> {
  const provider = rawProvider.trim().toLowerCase()
  if (!provider || !OFFICIAL_ENDPOINTS[provider]) return undefined
  const env = options.env ?? process.env

  /* ① 先核对生效端点：条目的任何不确定都必须发生在取 key 之前。 */
  const lookup = await readModelsEntry(provider, options.agentDir)
  if (lookup.kind === 'invalid') return undefined
  let entry: Record<string, unknown> | undefined
  if (lookup.kind === 'entry') {
    if (!entryEndpointAllowed(provider, lookup.entry)) return undefined
    entry = lookup.entry as Record<string, unknown>
  }

  /* ② auth.json 凭证优先（原生 `input.credential`）。 */
  const fromAuth = await readAuthKey(provider, options)
  if (fromAuth) return fromAuth

  /* ③ models.json 的 apiKey（原生 `rawKey`）：一旦声明，原生不再回退内置 env。 */
  if (entry) {
    const rawApiKey = entry.apiKey
    if (rawApiKey !== undefined && rawApiKey !== null) {
      if (typeof rawApiKey !== 'string' || !rawApiKey.trim()) return undefined
      const resolved = resolveNativeConfigValue(rawApiKey, env)
      return resolved && resolved.trim() ? resolved : undefined
    }
    /*
     * 条目没有 apiKey：只有能证明原生有内置 env 回退的 provider 才读 env。
     * commandcode 的随包扩展在 models.json 有条目时让位、无内置默认 —— 此时
     * 原生根本没有 env 来源，读了就会把全局 env 当成另一把 key。
     */
    if (!OFFICIAL_ENDPOINTS[provider].nativeDefaultBaseUrl) return undefined
  }

  /* ④ 内置环境变量（原生 `inherited`）。 */
  return readNativeEnv(provider, env)
}
