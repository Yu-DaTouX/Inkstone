/**
 * 联网搜索的本机配置：Brave Search API key 与「不再提示」开关。
 *
 * 单独放在 `YAN_DIR/search-config.json`，不写进 pi 的 `auth.json`：那里的条目会被
 * 当作模型 provider 列在设置页，搜索 key 不属于模型接入。密钥只在主进程读取，
 * 渲染端只能拿到「是否已配置」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { SearchApiConfigView } from '../../shared/search'

interface SearchConfigFile {
  braveKey?: string
  hintDismissed?: boolean
}

const CONFIG_FILE = (): string => join(YAN_DIR, 'search-config.json')
const ENV_NAME = 'BRAVE_API_KEY'

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

/** 只供主进程搜索使用；文件里的 key 优先于环境变量 */
export async function resolveBraveKey(): Promise<string | undefined> {
  const file = (await read()).braveKey?.trim()
  if (file) return file
  const env = process.env[ENV_NAME]?.trim()
  return env || undefined
}

export async function searchApiConfig(): Promise<SearchApiConfigView> {
  const cfg = await read()
  const fromFile = !!cfg.braveKey?.trim()
  const fromEnv = !fromFile && !!process.env[ENV_NAME]?.trim()
  return {
    configured: fromFile || fromEnv,
    source: fromFile ? 'file' : fromEnv ? 'env' : undefined,
    hintDismissed: cfg.hintDismissed === true
  }
}

export async function setBraveKey(key: string): Promise<{ ok: boolean; error?: string }> {
  const value = key.trim()
  if (!value) return { ok: false, error: 'API key 不能为空' }
  if (/\s/.test(value)) return { ok: false, error: 'API key 不应包含空白字符' }
  try {
    await write({ ...(await read()), braveKey: value })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}

export async function clearBraveKey(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { braveKey: _removed, ...rest } = await read()
    await write(rest)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}

export async function setSearchHintDismissed(dismissed: boolean): Promise<void> {
  await write({ ...(await read()), hintDismissed: dismissed })
}
