import { pick } from '../../shared/ui-lang'
import { constants as fsConstants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import { readCredentialFile, writeCredentialFile } from '../credential-vault'
import { resolveQuotaProviderSecret } from '../quota-credentials'
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

let chain: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function read(): Promise<SearchConfigFile> {
  const text = await readCredentialFile(CONFIG_FILE())
  if (text === null) return {}
  const parsed = JSON.parse(text) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SearchConfigFile) : {}
}

async function readForWrite(): Promise<SearchConfigFile> {
  const file = CONFIG_FILE()
  const text = await readCredentialFile(file)
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await copyFile(file, `${file}.corrupt.bak`, fsConstants.COPYFILE_EXCL).catch(() => undefined)
    throw new Error(pick(`搜索配置文件格式无效；为保护已保存的 key，已拒绝写入：${file}`, `The search settings file is invalid; write refused to protect saved keys: ${file}`))
  }
  return parsed as SearchConfigFile
}

async function write(next: SearchConfigFile): Promise<void> {
  await writeCredentialFile(CONFIG_FILE(), JSON.stringify(next, null, 2) + '\n')
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
  const deepseekModelKey = !!(await resolveQuotaProviderSecret('deepseek'))
  return {
    configured: providers.brave.configured || providers.tavily.configured || deepseekModelKey,
    hintDismissed: cfg.hintDismissed === true,
    providers,
    deepseekModelKey
  }
}

export async function setSearchKey(id: SearchProviderId, key: string): Promise<{ ok: boolean; error?: string }> {
  const value = key.trim()
  if (!value) return { ok: false, error: pick('API key 不能为空', 'API key cannot be empty') }
  if (/\s/.test(value)) return { ok: false, error: pick('API key 不应包含空白字符', 'API key must not contain whitespace') }
  try {
    await serial(async () => write({ ...(await readForWrite()), [fieldOf(id)]: value }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : pick('写入失败', 'Write failed') }
  }
}

export async function clearSearchKey(id: SearchProviderId): Promise<{ ok: boolean; error?: string }> {
  try {
    await serial(async () => {
      const next = { ...(await readForWrite()) }
      delete next[fieldOf(id)]
      await write(next)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : pick('删除失败', 'Delete failed') }
  }
}

export async function setSearchHintDismissed(dismissed: boolean): Promise<void> {
  await serial(async () => write({ ...(await readForWrite()), hintDismissed: dismissed }))
}
