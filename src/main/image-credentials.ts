/**
 * 生图通道的凭证来源：只在主进程内部读取，密钥不跨 IPC。
 *
 * - ChatGPT（Codex）：先用砚里登录的 `openai-codex`（pi 的 auth.json），过期时在 auth.json
 *   文件锁内刷新并写回 —— 与 pi 自己刷新用同一把锁，锁内再确认一次是否仍过期，避免两边轮换
 *   refresh token 时互相覆盖；砚里没登录时再读 Codex CLI 的 `~/.codex/auth.json`（只读，不替
 *   Codex CLI 刷新它自己的令牌）。
 * - API key：pi auth.json 里设置页填写的条目优先，其次环境变量。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readAuthEntry, updateAuthFile } from './credentials'
import { decodeJwtPayload, isCodexCredential, refreshCodexCredential } from './codex-token'

export type ImageSecretProvider = 'openai' | 'google' | 'doubao'

export interface CodexImageAuth {
  access: string
  accountId?: string
  /** yan = 砚内登录（pi auth.json）；codex-cli = Codex CLI 的 ~/.codex/auth.json */
  source: 'yan' | 'codex-cli'
}

export interface ImageCredentialSource {
  /** 只看有没有可用的登录，不发网络请求、不刷新 */
  hasCodex(): Promise<boolean>
  /** 取可直接请求的令牌；砚内登录过期时会刷新 */
  codex(): Promise<CodexImageAuth | null>
  secret(provider: ImageSecretProvider): Promise<string | undefined>
}

/** 与 codex-accounts 一致：提前 60 秒当作过期，免得请求途中失效 */
const EXPIRY_MARGIN_MS = 60_000

/** pi auth.json 里的键与环境变量后备 */
const SECRET_SOURCES: Record<ImageSecretProvider, { authKey: string; env: string[] }> = {
  openai: { authKey: 'openai', env: ['OPENAI_API_KEY'] },
  google: { authKey: 'google', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  doubao: { authKey: 'volcengine-ark', env: ['ARK_API_KEY'] }
}

function entryKey(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined
  const key = (entry as { key?: unknown } | null)?.key
  return typeof key === 'string' && key.trim() ? key.trim() : undefined
}

async function readCodexCliAuth(): Promise<CodexImageAuth | null> {
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  try {
    const auth = JSON.parse(await readFile(join(root, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } }
    const access = auth.tokens?.access_token
    if (typeof access !== 'string' || !access) return null
    const exp = decodeJwtPayload(access)?.exp
    if (typeof exp === 'number' && exp * 1000 <= Date.now() + EXPIRY_MARGIN_MS) return null
    const accountId = auth.tokens?.account_id
    return { access, ...(typeof accountId === 'string' && accountId ? { accountId } : {}), source: 'codex-cli' }
  } catch {
    return null
  }
}

async function readYanCodexAuth(): Promise<CodexImageAuth | null> {
  const entry = await readAuthEntry('openai-codex')
  if (!isCodexCredential(entry)) return null
  if (Number(entry.expires) > Date.now() + EXPIRY_MARGIN_MS) return { access: entry.access, accountId: entry.accountId, source: 'yan' }
  try {
    return await updateAuthFile(async (data) => {
      const current = data['openai-codex']
      if (!isCodexCredential(current)) return { write: false, result: null }
      /* 等锁期间 pi 可能已经刷新过：锁内再看一次，仍有效就直接用 */
      if (Number(current.expires) > Date.now() + EXPIRY_MARGIN_MS) {
        return { write: false, result: { access: current.access, accountId: current.accountId, source: 'yan' as const } }
      }
      const next = await refreshCodexCredential(current.refresh)
      data['openai-codex'] = { ...current, ...next }
      return { write: true, result: { access: next.access, accountId: next.accountId, source: 'yan' as const } }
    })
  } catch {
    return null
  }
}

export const hostImageCredentials: ImageCredentialSource = {
  async hasCodex() {
    return isCodexCredential(await readAuthEntry('openai-codex')) || !!(await readCodexCliAuth())
  },
  async codex() {
    return (await readYanCodexAuth()) ?? (await readCodexCliAuth())
  },
  async secret(provider) {
    const source = SECRET_SOURCES[provider]
    const stored = entryKey(await readAuthEntry(source.authKey))
    if (stored) return stored
    for (const name of source.env) {
      const value = process.env[name]?.trim()
      if (value) return value
    }
    return undefined
  }
}
