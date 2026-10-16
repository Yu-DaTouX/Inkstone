import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readAuthEntry, updateAuthFile } from './credentials'
import { decodeJwtPayload, isCodexCredential, refreshCodexCredential } from './codex-token'

export type ImageSecretProvider = 'openai' | 'google' | 'doubao'

export interface CodexImageAuth {
  access: string
  accountId?: string
  source: 'yan' | 'codex-cli'
}

export interface ImageCredentialSource {
  hasCodex(): Promise<boolean>
  codex(): Promise<CodexImageAuth | null>
  secret(provider: ImageSecretProvider): Promise<string | undefined>
}

const EXPIRY_MARGIN_MS = 60_000

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
