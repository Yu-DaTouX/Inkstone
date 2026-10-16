import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  if (process.platform !== 'win32') await chmod(CONFIG_FILE(), 0o600)
}

function stateOf(cfg: SearchConfigFile, id: SearchProviderId): SearchProviderState {
  const fromFile = !!cfg[fieldOf(id)]?.trim()
  const fromEnv = !fromFile && !!process.env[envNameOf(id)]?.trim()
  return { configured: fromFile || fromEnv, ...(fromFile ? { source: 'file' as const } : fromEnv ? { source: 'env' as const } : {}) }
}

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
