/**
 * 增强搜索的本机配置：各服务（Brave / Tavily / Firecrawl / Context7）的 API key
 * 与「不再提示」开关。
 *
 * 单独放在 `YAN_DIR/search-config.json`，不写进 pi 的 `auth.json`：那里的条目会被
 * 当作模型 provider 列在设置页，搜索 key 不属于模型接入。密钥只在主进程读取，
 * 渲染端只能拿到「是否已配置」。文件字段是 `<服务>Key`，旧版只有 `braveKey`，保持兼容。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import {
  SEARCH_PROVIDERS,
  type SearchApiConfigView,
  type SearchProviderId,
  type SearchProviderState
} from '../../shared/search'

type SearchConfigFile = { hintDismissed?: boolean } & Partial<Record<`${SearchProviderId}Key`, string>>

const CONFIG_FILE = (): string => join(YAN_DIR, 'search-config.json')

const fieldOf = (id: SearchProviderId): `${SearchProviderId}Key` => `${id}Key`
const envNameOf = (id: SearchProviderId): string => SEARCH_PROVIDERS.find((provider) => provider.id === id)!.envName

async function read(): Promise<SearchConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE(), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SearchConfigFile) : {}
  } catch {
    return {}
  }
}

async function write(next: SearchConfigFile): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  await writeFile(CONFIG_FILE(), JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

function stateOf(cfg: SearchConfigFile, id: SearchProviderId): SearchProviderState {
  const fromFile = !!cfg[fieldOf(id)]?.trim()
  const fromEnv = !fromFile && !!process.env[envNameOf(id)]?.trim()
  return { configured: fromFile || fromEnv, ...(fromFile ? { source: 'file' as const } : fromEnv ? { source: 'env' as const } : {}) }
}

/** 只供主进程搜索使用；文件里的 key 优先于环境变量 */
export async function resolveSearchKey(id: SearchProviderId): Promise<string | undefined> {
  const file = (await read())[fieldOf(id)]?.trim()
  if (file) return file
  return process.env[envNameOf(id)]?.trim() || undefined
}

export const resolveBraveKey = (): Promise<string | undefined> => resolveSearchKey('brave')

export async function searchApiConfig(): Promise<SearchApiConfigView> {
  const cfg = await read()
  const providers = Object.fromEntries(SEARCH_PROVIDERS.map((provider) => [provider.id, stateOf(cfg, provider.id)])) as Record<
    SearchProviderId,
    SearchProviderState
  >
  return {
    /* 提醒只看通用网页搜索：Firecrawl / Context7 不是用来替代 Bing 兜底的 */
    configured: providers.brave.configured || providers.tavily.configured,
    hintDismissed: cfg.hintDismissed === true,
    providers
  }
}

export async function setSearchKey(id: SearchProviderId, key: string): Promise<{ ok: boolean; error?: string }> {
  const value = key.trim()
  if (!value) return { ok: false, error: 'API key 不能为空' }
  if (/\s/.test(value)) return { ok: false, error: 'API key 不应包含空白字符' }
  try {
    await write({ ...(await read()), [fieldOf(id)]: value })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}

export async function clearSearchKey(id: SearchProviderId): Promise<{ ok: boolean; error?: string }> {
  try {
    const next = { ...(await read()) }
    delete next[fieldOf(id)]
    await write(next)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}

export async function setSearchHintDismissed(dismissed: boolean): Promise<void> {
  await write({ ...(await read()), hintDismissed: dismissed })
}
