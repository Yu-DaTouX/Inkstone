import { pick } from '../shared/ui-lang'
import { readFile, mkdir, stat, readdir, realpath, rmdir, utimes } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { AuthProviderInfo, AuthStatus, FileListingStatus, FileRequestContext, PathCompletionResult } from '../shared/ipc'
import { PI_AGENT_DIR } from './paths'
import { atomicWriteFile } from './atomic-write'

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

const CATALOG: (Omit<AuthProviderInfo, 'status'> & { legacyEnvVar?: string })[] = [
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
  { id: 'xai', get name() { return pick('xAI（Grok / X 订阅）', 'xAI (Grok / X subscription)') }, kind: 'subscription', envVar: 'XAI_API_KEY', authKey: 'xai', loginCmd: 'pi', inAppLogin: true },
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
  { id: 'opencode', name: 'OpenCode Zen', kind: 'api_key', envVar: 'OPENCODE_API_KEY', authKey: 'opencode' },
  { id: 'opencode-go', name: 'OpenCode Go', kind: 'api_key', envVar: 'OPENCODE_API_KEY', authKey: 'opencode-go' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'api_key', envVar: 'DEEPSEEK_API_KEY', authKey: 'deepseek' },
  { id: 'openai', name: 'OpenAI', kind: 'api_key', envVar: 'OPENAI_API_KEY', authKey: 'openai' },
  { id: 'google', name: 'Google Gemini', kind: 'api_key', envVar: 'GEMINI_API_KEY', authKey: 'google' },
  { id: 'volcengine-ark', get name() { return pick('火山方舟（豆包）', 'Volcengine Ark (Doubao)') }, kind: 'api_key', envVar: 'ARK_API_KEY', authKey: 'volcengine-ark' },
  { id: 'zai-coding-cn', get name() { return pick('ZAI 编程套餐（国内）', 'ZAI Coding Plan (China)') }, kind: 'api_key', envVar: 'ZAI_CODING_CN_API_KEY', authKey: 'zai-coding-cn' },
  { id: 'zai', name: 'Z.AI', kind: 'api_key', envVar: 'ZAI_API_KEY', authKey: 'zai' },
  { id: 'kimi-coding', name: 'Kimi For Coding', kind: 'api_key', envVar: 'KIMI_API_KEY', authKey: 'kimi-coding' },
  { id: 'moonshotai', get name() { return pick('Moonshot AI（Kimi 国际）', 'Moonshot AI (Kimi Global)') }, kind: 'api_key', envVar: 'MOONSHOT_API_KEY', authKey: 'moonshotai' },
  { id: 'moonshotai-cn', get name() { return pick('Moonshot AI（Kimi 国内）', 'Moonshot AI (Kimi China)') }, kind: 'api_key', envVar: 'MOONSHOT_API_KEY', authKey: 'moonshotai-cn' },
  { id: 'minimax-cn', get name() { return pick('MiniMax（国内）', 'MiniMax (China)') }, kind: 'api_key', envVar: 'MINIMAX_CN_API_KEY', authKey: 'minimax-cn' },
  { id: 'minimax', get name() { return pick('MiniMax（国际）', 'MiniMax (Global)') }, kind: 'api_key', envVar: 'MINIMAX_API_KEY', authKey: 'minimax' },
  { id: 'qwen-token-plan-cn', get name() { return pick('Qwen Token Plan 团队（国内）', 'Qwen Token Plan Team (China)') }, kind: 'api_key', envVar: 'QWEN_TOKEN_PLAN_TEAM_CN_API_KEY', legacyEnvVar: 'QWEN_TOKEN_PLAN_CN_API_KEY', authKey: 'qwen-token-plan-cn' },
  { id: 'qwen-token-plan', get name() { return pick('Qwen Token Plan 团队（国际）', 'Qwen Token Plan Team (Global)') }, kind: 'api_key', envVar: 'QWEN_TOKEN_PLAN_TEAM_API_KEY', legacyEnvVar: 'QWEN_TOKEN_PLAN_API_KEY', authKey: 'qwen-token-plan' },
  { id: 'qwen-token-plan-individual', get name() { return pick('Qwen Token Plan 个人（国际）', 'Qwen Token Plan Individual (Global)') }, kind: 'api_key', envVar: 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY', legacyEnvVar: 'QWEN_TOKEN_PLAN_API_KEY', authKey: 'qwen-token-plan-individual' },
  { id: 'qwen-token-plan-individual-cn', get name() { return pick('Qwen Token Plan 个人（国内）', 'Qwen Token Plan Individual (China)') }, kind: 'api_key', envVar: 'QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY', legacyEnvVar: 'QWEN_TOKEN_PLAN_CN_API_KEY', authKey: 'qwen-token-plan-individual-cn' },
  { id: 'xai-api', name: 'xAI（API key）', kind: 'api_key', envVar: 'XAI_API_KEY', authKey: 'xai' },
  { id: 'groq', name: 'Groq', kind: 'api_key', envVar: 'GROQ_API_KEY', authKey: 'groq' },
  { id: 'mistral', name: 'Mistral', kind: 'api_key', envVar: 'MISTRAL_API_KEY', authKey: 'mistral' },
  { id: 'together', name: 'Together AI', kind: 'api_key', envVar: 'TOGETHER_API_KEY', authKey: 'together' },
  { id: 'fireworks', name: 'Fireworks', kind: 'api_key', envVar: 'FIREWORKS_API_KEY', authKey: 'fireworks' },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'api_key', envVar: 'NVIDIA_API_KEY', authKey: 'nvidia' },
  { id: 'cerebras', name: 'Cerebras', kind: 'api_key', envVar: 'CEREBRAS_API_KEY', authKey: 'cerebras' },
  { id: 'baseten', name: 'Baseten', kind: 'api_key', envVar: 'BASETEN_API_KEY', authKey: 'baseten' },
  { id: 'ant-ling', name: 'Ant Ling', kind: 'api_key', envVar: 'ANT_LING_API_KEY', authKey: 'ant-ling' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'api_key', envVar: 'HF_TOKEN', authKey: 'huggingface' },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', kind: 'api_key', envVar: 'AI_GATEWAY_API_KEY', authKey: 'vercel-ai-gateway' },
  { id: 'meta', name: 'Meta（Muse）', kind: 'api_key', envVar: 'META_API_KEY', authKey: 'meta' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', kind: 'api_key', envVar: 'XIAOMI_API_KEY', authKey: 'xiaomi' },
  { id: 'xiaomi-token-plan-cn', get name() { return pick('Xiaomi MiMo 套餐（国内）', 'Xiaomi MiMo Plan (China)') }, kind: 'api_key', envVar: 'XIAOMI_TOKEN_PLAN_CN_API_KEY', authKey: 'xiaomi-token-plan-cn' },
  { id: 'xiaomi-token-plan-ams', get name() { return pick('Xiaomi MiMo 套餐（阿姆斯特丹）', 'Xiaomi MiMo Plan (Amsterdam)') }, kind: 'api_key', envVar: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', authKey: 'xiaomi-token-plan-ams' },
  { id: 'xiaomi-token-plan-sgp', get name() { return pick('Xiaomi MiMo 套餐（新加坡）', 'Xiaomi MiMo Plan (Singapore)') }, kind: 'api_key', envVar: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', authKey: 'xiaomi-token-plan-sgp' },
  { id: 'openrouter-key', name: 'OpenRouter（API key）', kind: 'api_key', envVar: 'OPENROUTER_API_KEY', authKey: 'openrouter' }
]

const HOST_ONLY_PROVIDERS = new Set(['volcengine-ark'])

export async function readAuth(): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(AUTH_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(pick('auth.json 格式无效；为保护现有凭证，已拒绝写入', 'auth.json is invalid; write refused to protect existing credentials'))
  return value as Record<string, unknown>
}

async function writeAuthAtomic(data: Record<string, unknown>): Promise<void> {
  await atomicWriteFile(AUTH_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, durable: true })
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
    if (Date.now() > deadline) throw new Error(pick('凭证文件正被 pi 占用，请稍后再试', 'The credentials file is in use by pi; try again shortly'))
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

export function validProviderId(provider: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) && !['__proto__', 'prototype', 'constructor'].includes(provider)
}

export async function setApiKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const id = provider.trim()
  const val = key.trim()
  if (!validProviderId(id)) return { ok: false, error: pick('provider 名称无效', 'Invalid provider name') }
  if (!val) return { ok: false, error: pick('API key 不能为空', 'API key cannot be empty') }
  return mergeAuthEntry(id, { type: 'api_key', key: val })
}

export async function mergeAuthEntry(provider: string, value: unknown, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  if (!validProviderId(provider)) return { ok: false, error: pick('provider 名称无效', 'Invalid provider name') }
  try {
    await updateAuthFile((data) => {
      if (signal?.aborted) throw new Error(pick('已取消登录', 'Sign-in cancelled'))
      data[provider] = value
      return { write: true, result: undefined }
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : pick('写入失败', 'Write failed') }
  }
}

export async function clearAuth(provider: string): Promise<{ ok: boolean; error?: string }> {
  if (!validProviderId(provider)) return { ok: false, error: pick('provider 名称无效', 'Invalid provider name') }
  try {
    await updateAuthFile((data) => {
      if (!(provider in data)) return { write: false, result: undefined }
      delete data[provider]
      return { write: true, result: undefined }
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : pick('删除失败', 'Delete failed') }
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
          resolve({ status: 'unknown', detail: pick('无法查询（pi 未找到或未安装）', 'Cannot check (pi not found or not installed)') })
          return
        }
        try {
          const j = JSON.parse(String(stdout).trim()) as { status?: string; reason?: string; authType?: string }
          resolve({
            status: j.status === 'ready' ? 'ready' : 'missing',
            detail: j.reason === 'credentials_not_configured' ? pick('未配置凭证', 'No credentials configured') : j.reason
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

  const base: AuthProviderInfo[] = CATALOG.map(({ legacyEnvVar, ...provider }) => {
    const activeEnvVar = [provider.envVar, legacyEnvVar].find((name) => name && fromEnv(name))
    if ((provider.authKey && configured.has(provider.authKey)) || configured.has(provider.id)) {
      return { ...provider, status: 'ready', source: 'auth.json', ...(activeEnvVar ? { envShadowed: true } : {}) }
    }
    if (activeEnvVar) {
      return { ...provider, envVar: activeEnvVar, status: 'ready', source: 'env' }
    }
    return { ...provider, status: 'missing' }
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
