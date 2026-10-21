import { readFile, mkdir, stat, readdir, realpath, rmdir, utimes, open, rename, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { AuthProviderInfo, AuthStatus, FileListingStatus, FileRequestContext, PathCompletionResult } from '../shared/ipc'
import { PI_AGENT_DIR } from './paths'

const PI_DIR = PI_AGENT_DIR
const AUTH_FILE = join(PI_DIR, 'auth.json')

export async function resolveCodexAccountId(): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(AUTH_FILE, 'utf8')) as Record<string, unknown>
    const entry = data['openai-codex'] as { accountId?: unknown } | undefined
    return typeof entry?.accountId === 'string' ? entry.accountId : undefined
  } catch {
    return undefined
  }
}

const CATALOG: Omit<AuthProviderInfo, 'status'>[] = [
  {
    id: 'openai-codex',
    name: 'ChatGPT Plus / Pro',
    kind: 'subscription',
    envVar: '',
    authKey: '',
    loginCmd: 'pi',
    inAppLogin: true
  },
  {
    id: 'anthropic',
    name: 'Claude Pro / Max',
    kind: 'subscription',
    envVar: 'ANTHROPIC_API_KEY',
    authKey: 'anthropic',
    loginCmd: 'pi',
    inAppLogin: true
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    kind: 'subscription',
    envVar: '',
    authKey: '',
    loginCmd: 'pi',
    inAppLogin: true
  },
  { id: 'xai', name: 'xAI（Grok / X 订阅）', kind: 'subscription', envVar: 'XAI_API_KEY', authKey: 'xai', loginCmd: 'pi', inAppLogin: true },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'subscription',
    envVar: 'OPENROUTER_API_KEY',
    authKey: 'openrouter',
    loginCmd: 'pi',
    inAppLogin: true
  },

  {
    id: 'commandcode',
    name: 'Command Code',
    kind: 'api_key',
    envVar: 'COMMANDCODE_API_KEY',
    authKey: 'commandcode'
  },
  { id: 'deepseek', name: 'DeepSeek', kind: 'api_key', envVar: 'DEEPSEEK_API_KEY', authKey: 'deepseek' },
  { id: 'openai', name: 'OpenAI', kind: 'api_key', envVar: 'OPENAI_API_KEY', authKey: 'openai' },
  { id: 'google', name: 'Google Gemini', kind: 'api_key', envVar: 'GEMINI_API_KEY', authKey: 'google' },
  { id: 'volcengine-ark', name: '火山方舟（豆包）', kind: 'api_key', envVar: 'ARK_API_KEY', authKey: 'volcengine-ark' },
  { id: 'zai-coding-cn', name: 'ZAI 编程套餐（国内）', kind: 'api_key', envVar: 'ZAI_CODING_CN_API_KEY', authKey: 'zai-coding-cn' },
  { id: 'kimi-coding', name: 'Kimi For Coding', kind: 'api_key', envVar: 'KIMI_API_KEY', authKey: 'kimi-coding' },
  { id: 'minimax-cn', name: 'MiniMax（国内）', kind: 'api_key', envVar: 'MINIMAX_CN_API_KEY', authKey: 'minimax-cn' },
  { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan（国内）', kind: 'api_key', envVar: 'QWEN_TOKEN_PLAN_CN_API_KEY', authKey: 'qwen-token-plan-cn' },
  { id: 'xai-api', name: 'xAI（API key）', kind: 'api_key', envVar: 'XAI_API_KEY', authKey: 'xai' },
  { id: 'groq', name: 'Groq', kind: 'api_key', envVar: 'GROQ_API_KEY', authKey: 'groq' },
  { id: 'mistral', name: 'Mistral', kind: 'api_key', envVar: 'MISTRAL_API_KEY', authKey: 'mistral' },
  { id: 'together', name: 'Together AI', kind: 'api_key', envVar: 'TOGETHER_API_KEY', authKey: 'together' },
  { id: 'fireworks', name: 'Fireworks', kind: 'api_key', envVar: 'FIREWORKS_API_KEY', authKey: 'fireworks' },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'api_key', envVar: 'NVIDIA_API_KEY', authKey: 'nvidia' },
  { id: 'openrouter-key', name: 'OpenRouter（API key）', kind: 'api_key', envVar: 'OPENROUTER_API_KEY', authKey: 'openrouter' }
]

const HOST_ONLY_PROVIDERS = new Set(['volcengine-ark'])

async function readAuth(): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(AUTH_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('auth.json 格式无效；为保护现有凭证，已拒绝写入')
  return value as Record<string, unknown>
}

async function writeAuthAtomic(data: Record<string, unknown>): Promise<void> {
  const tmp = `${AUTH_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, AUTH_FILE)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function readAuthEntry(provider: string): Promise<unknown> {
  return (await readAuth())[provider]
}

const AUTH_LOCK = `${AUTH_FILE}.lock`
const AUTH_LOCK_STALE_MS = 10_000
const AUTH_LOCK_TOUCH_MS = 2_500
const AUTH_LOCK_WAIT_MS = 5_000
const AUTH_LOCK_POLL_MS = 60

async function lockMtimeMs(): Promise<number | null> {
  try {
    return (await stat(AUTH_LOCK)).mtimeMs
  } catch {
    return null
  }
}

async function acquireAuthLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(AUTH_LOCK)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const firstSeen = await lockMtimeMs()
    if (firstSeen !== null && Date.now() - firstSeen > AUTH_LOCK_STALE_MS) {
      const confirmed = await lockMtimeMs()
      if (confirmed !== null && confirmed === firstSeen) {
        await rmdir(AUTH_LOCK).catch(() => undefined)
        continue
      }
    }
    if (Date.now() > deadline) throw new Error('凭证文件正被 pi 占用，请稍后再试')
    await new Promise((r) => setTimeout(r, AUTH_LOCK_POLL_MS))
  }
  const timer = setInterval(() => {
    const now = new Date()
    void utimes(AUTH_LOCK, now, now).catch(() => undefined)
  }, AUTH_LOCK_TOUCH_MS)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    await rmdir(AUTH_LOCK).catch(() => undefined)
  }
}

export async function updateAuthFile<T>(
  fn: (data: Record<string, unknown>) => { write: boolean; result: T } | Promise<{ write: boolean; result: T }>
): Promise<T> {
  await mkdir(PI_DIR, { recursive: true })
  const release = await acquireAuthLock()
  try {
    const data = await readAuth()
    const { write, result } = await fn(data)
    if (write) await writeAuthAtomic(data)
    return result
  } finally {
    await release()
  }
}

function validProviderId(provider: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) && !['__proto__', 'prototype', 'constructor'].includes(provider)
}

export async function setApiKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const id = provider.trim()
  const val = key.trim()
  if (!validProviderId(id)) return { ok: false, error: 'provider 名称无效' }
  if (!val) return { ok: false, error: 'API key 不能为空' }
  return mergeAuthEntry(id, { type: 'api_key', key: val })
}

export async function mergeAuthEntry(provider: string, value: unknown, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  if (!validProviderId(provider)) return { ok: false, error: 'provider 名称无效' }
  try {
    await updateAuthFile((data) => {
      if (signal?.aborted) throw new Error('已取消登录')
      data[provider] = value
      return { write: true, result: undefined }
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}

export async function clearAuth(provider: string): Promise<{ ok: boolean; error?: string }> {
  if (!validProviderId(provider)) return { ok: false, error: 'provider 名称无效' }
  try {
    await updateAuthFile((data) => {
      if (!(provider in data)) return { write: false, result: undefined }
      delete data[provider]
      return { write: true, result: undefined }
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}

function checkViaPi(
  piCmd: string,
  piArgs: string[],
  provider: string
): Promise<{ status: AuthStatus; detail?: string }> {
  return new Promise((resolve) => {
    execFile(
      piCmd,
      [...piArgs, 'auth', 'check', '--provider', provider, '--json'],
      { timeout: 20_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ status: 'unknown', detail: '无法查询（pi 未找到或未安装）' })
          return
        }
        try {
          const j = JSON.parse(String(stdout).trim()) as { status?: string; reason?: string; authType?: string }
          resolve({
            status: j.status === 'ready' ? 'ready' : 'missing',
            detail: j.reason === 'credentials_not_configured' ? '未配置凭证' : j.reason
          })
        } catch {
          resolve({ status: 'unknown' })
        }
      }
    )
  })
}

export function authEntryHasSecret(entry: unknown): boolean {
  if (typeof entry === 'string') return entry.trim().length > 0
  const value = entry as { type?: unknown; key?: unknown } | null
  return !!value && (!!value.key || value.type === 'oauth')
}

export async function listAuthProviders(
  pi: { cmd: string; args: string[] },
  deep = false
): Promise<AuthProviderInfo[]> {
  const auth = await readAuth()
  const configured = new Set<string>()
  for (const [k, v] of Object.entries(auth)) {
    if (authEntryHasSecret(v)) configured.add(k)
  }

  const fromEnv = (name: string): boolean => {
    if (!name) return false
    const v = process.env[name]
    return typeof v === 'string' && v.trim().length > 0
  }

  const base: AuthProviderInfo[] = CATALOG.map((c) => {
    if ((c.authKey && configured.has(c.authKey)) || configured.has(c.id)) {
      return { ...c, status: 'ready' as const, source: 'auth.json' as const }
    }
    if (fromEnv(c.envVar)) {
      return { ...c, status: 'ready' as const, source: 'env' as const }
    }
    return { ...c, status: 'missing' as const }
  })

  const known = new Set<string>()
  for (const c of CATALOG) {
    if (c.authKey) known.add(c.authKey)
    known.add(c.id)
  }
  for (const id of configured) {
    if (known.has(id)) continue
    base.push({
      id,
      name: id,
      kind: 'api_key',
      envVar: '',
      authKey: id,
      status: 'ready',
      source: 'auth.json'
    })
  }

  if (!deep) return base

  const results = new Array<AuthProviderInfo>(base.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(3, base.length) }, async () => {
    while (cursor < base.length) {
      const index = cursor++
      const c = base[index]
      results[index] = await (async () => {
      if (HOST_ONLY_PROVIDERS.has(c.id)) return c
      const probeId = c.kind === 'subscription' || c.name === c.id ? c.id : c.authKey || c.id
      const r = await checkViaPi(pi.cmd, pi.args, probeId)
      if (r.status === 'ready') return { ...c, status: 'ready' as const }
      if (r.status === 'missing') return { ...c, status: 'missing' as const }
      return c
      })()
    }
  })
  await Promise.all(workers)
  return results
}

export async function authFileInfo(): Promise<{ path: string; exists: boolean; count: number }> {
  try {
    await stat(AUTH_FILE)
    const j = await readAuth()
    return { path: AUTH_FILE, exists: true, count: Object.keys(j).length }
  } catch {
    return { path: AUTH_FILE, exists: false, count: 0 }
  }
}

export async function completePath(
  cwd: string,
  prefix: string,
  request?: FileRequestContext
): Promise<PathCompletionResult> {
  const result = (status: FileListingStatus, paths: string[] = [], truncated = false): PathCompletionResult => ({
    paths,
    truncated,
    status,
    ...(request ? { request } : {})
  })
  const rawInput = String(prefix ?? '').replace(/\\/g, '/')
  const raw = /^(['"]).*\1$/.test(rawInput)
    ? rawInput.slice(1, -1)
    : rawInput.replace(/^['"]/, '')
  if (raw.includes('\0')) return result('invalid')
  const slash = raw.lastIndexOf('/')
  const dirPart = slash >= 0 ? raw.slice(0, slash) : ''
  const namePart = (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase()

  if (dirPart.split(/[\\/]+/).includes('..') || /^[A-Za-z]:/.test(dirPart) || dirPart.startsWith('/')) return result('invalid')

  let root: string
  try {
    root = await realpath(cwd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return result(code === 'EACCES' || code === 'EPERM' ? 'permission' : 'missing')
  }
  const base = resolve(join(root, dirPart))
  const rootKey = root.replace(/[\\/]+/g, '/').toLowerCase()
  const baseKey = base.replace(/[\\/]+/g, '/').toLowerCase()
  if (baseKey !== rootKey && !baseKey.startsWith(rootKey + '/')) return result('invalid')
  try {
    const realBase = await realpath(base)
    const realKey = realBase.replace(/[\\/]+/g, '/').toLowerCase()
    if (realKey !== rootKey && !realKey.startsWith(rootKey + '/')) return result('invalid')
    if (realKey !== baseKey) return result('invalid')
    const entries = await readdir(realBase, { withFileTypes: true })
    const dirs: string[] = []
    const files: string[] = []
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.svn' || e.name === '.hg') continue
      if (e.name.startsWith('.')) continue
      if (e.isSymbolicLink()) continue
      if (namePart && !e.name.toLowerCase().startsWith(namePart)) continue
      const rel = (dirPart ? dirPart + '/' : '') + e.name + (e.isDirectory() ? '/' : '')
      if (e.isDirectory()) dirs.push(rel)
      else files.push(rel)
    }
    const byName = (a: string, b: string): number =>
      a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
    dirs.sort(byName)
    files.sort(byName)
    const all = [...dirs, ...files]
    return result(all.length ? 'ok' : 'empty', all.slice(0, 30), all.length > 30)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return result(code === 'EACCES' || code === 'EPERM' ? 'permission' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error')
  }
}
