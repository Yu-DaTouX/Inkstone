import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { net } from 'electron'
import { YAN_DIR } from './paths'
import { readAuth, readAuthEntry, updateAuthFile } from './credentials'
import { decodeJwtClaims } from '../shared/account-quota'
import { OAUTH_ACCOUNT_PROVIDERS, supportsOAuthAccounts, type OAuthAccountPools, type OAuthAccountProvider, type OAuthAccountView } from '../shared/oauth-accounts'

const STORE_FILE = join(YAN_DIR, 'oauth-accounts.json')

type Credential = { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown }
export interface OAuthAccountTarget extends OAuthAccountView {
  credential: Credential
}
type Result = { ok: boolean; error?: string }
type StoredAccount = { key: string; identity: string; email?: string; label?: string; credential: Credential }
type Store = { version: 1; providers: Partial<Record<OAuthAccountProvider, StoredAccount[]>> }

let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function isCredential(value: unknown): value is Credential {
  const c = value as Partial<Credential> | null
  return !!c && c.type === 'oauth' && typeof c.access === 'string' && !!c.access && typeof c.refresh === 'string' && typeof c.expires === 'number'
}

function sameCredential(a: Credential, b: Credential): boolean {
  return (a.enterpriseUrl ?? 'github.com') === (b.enterpriseUrl ?? 'github.com') &&
    (a.access === b.access || (!!a.refresh && a.refresh === b.refresh))
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

async function readStore(): Promise<Store> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(STORE_FILE, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, providers: {} }
    if (!(error instanceof SyntaxError)) throw error
  }
  const store = raw as Store | null
  if (!store || store.version !== 1 || !store.providers || typeof store.providers !== 'object' || Array.isArray(store.providers) ||
      Object.entries(store.providers).some(([provider, accounts]) => !supportsOAuthAccounts(provider) || !Array.isArray(accounts) ||
        accounts.some((a) => !a || typeof a.key !== 'string' || typeof a.identity !== 'string' || !isCredential(a.credential)))) {
    await copyFile(STORE_FILE, `${STORE_FILE}.corrupt.bak`, constants.COPYFILE_EXCL).catch(() => undefined)
    throw new Error(`账号列表格式无效；为保护已保存的账号，已拒绝写入：${STORE_FILE}`)
  }
  return store
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, STORE_FILE)
}

async function profile(url: string, access: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await net.fetch(url, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as Record<string, unknown>
}

async function identity(provider: OAuthAccountProvider, credential: Credential): Promise<{ identity: string; email?: string; label?: string }> {
  const claims = decodeJwtClaims(credential.access)
  const subject = string(claims.sub)
  const email = string(claims.email)
  const domain = string(credential.enterpriseUrl) ?? 'github.com'
  if (subject) return { identity: `${provider}:${domain}:${subject}`, email }
  try {
    if (provider === 'anthropic') {
      const data = await profile('https://api.anthropic.com/api/oauth/profile', credential.access, { 'anthropic-beta': 'oauth-2025-04-20' })
      const account = data.account as Record<string, unknown> | undefined
      const organization = data.organization as Record<string, unknown> | undefined
      if (string(account?.uuid)) return { identity: `anthropic:${string(organization?.uuid) ?? ''}:${account!.uuid}`, email: string(account?.email_address) }
    }
    if (provider === 'github-copilot' && domain === 'github.com' && credential.refresh) {
      const data = await profile('https://api.github.com/user', credential.refresh)
      const userId = string(data.id) ?? (typeof data.id === 'number' && Number.isFinite(data.id) ? String(data.id) : undefined)
      if (userId) return { identity: `github-copilot:${domain}:${userId}`, email: string(data.email), label: string(data.login) }
    }
  } catch {
  }
  const fingerprint = createHash('sha256').update(credential.refresh || credential.access).digest('hex')
  return { identity: `${provider}:${domain}:credential:${fingerprint}`, email }
}

async function upsert(store: Store, provider: OAuthAccountProvider, credential: Credential): Promise<StoredAccount> {
  const accounts = store.providers[provider] ??= []
  let account = accounts.find((a) => sameCredential(a.credential, credential))
  if (!account) {
    const info = await identity(provider, credential)
    account = accounts.find((a) => a.identity === info.identity)
    if (!account) {
      account = { key: `oauth:${provider}:${randomUUID()}`, ...info, credential }
      accounts.push(account)
    } else {
      account.email = info.email ?? account.email
    }
  }
  account.credential = credential
  return account
}

function view(account: StoredAccount, activeKey?: string): OAuthAccountView {
  return { key: account.key, email: account.email, label: account.label, active: account.key === activeKey }
}

export function captureActiveOAuthAccount(provider: string): Promise<{ key: string; credential: Credential } | undefined> {
  return serial(async () => {
    if (!supportsOAuthAccounts(provider)) return undefined
    const current = await readAuthEntry(provider)
    if (!isCredential(current)) return undefined
    const store = await readStore()
    const account = await upsert(store, provider, current)
    await writeStore(store)
    return { key: account.key, credential: current }
  })
}

export function listOAuthAccounts(): Promise<OAuthAccountPools> {
  return serial(async () => {
    const store = await readStore()
    const auth = await readAuth()
    const result: OAuthAccountPools = {}
    await Promise.all(OAUTH_ACCOUNT_PROVIDERS.map(async (provider) => {
      const current = auth[provider]
      const active = isCredential(current) ? await upsert(store, provider, current) : undefined
      const accounts = store.providers[provider]
      if (accounts?.length) result[provider] = accounts.map((a) => view(a, active?.key))
    }))
    await writeStore(store)
    return result
  })
}

async function mutate(provider: string, work: (store: Store, provider: OAuthAccountProvider) => Promise<void>): Promise<Result> {
  try {
    if (!supportsOAuthAccounts(provider)) throw new Error('这个服务不支持订阅账号管理')
    await serial(async () => work(await readStore(), provider))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function switchOAuthAccount(provider: string, key: string): Promise<Result> {
  return mutate(provider, async (store, id) => {
    const target = store.providers[id]?.find((a) => a.key === key)
    if (!target) throw new Error('找不到这个账号，可能已被删除')
    await updateAuthFile(async (auth) => {
      const current = auth[id]
      if (isCredential(current)) await upsert(store, id, current)
      await writeStore(store)
      auth[id] = target.credential
      return { write: true, result: undefined }
    })
  })
}

export async function removeOAuthAccount(provider: string, key: string): Promise<Result & { wasActive: boolean }> {
  let wasActive = false
  const result = await mutate(provider, async (store, id) => {
    await updateAuthFile(async (auth) => {
      const current = auth[id]
      const active = isCredential(current) ? await upsert(store, id, current) : undefined
      if (!store.providers[id]?.some((a) => a.key === key)) throw new Error('找不到这个账号，可能已被删除')
      wasActive = active?.key === key
      store.providers[id] = store.providers[id]!.filter((a) => a.key !== key)
      await writeStore(store)
      if (wasActive) delete auth[id]
      return { write: wasActive, result: undefined }
    })
  })
  return { ...result, wasActive }
}

export function renameOAuthAccount(provider: string, key: string, label: string): Promise<Result> {
  return mutate(provider, async (store, id) => {
    const account = store.providers[id]?.find((a) => a.key === key)
    if (!account) throw new Error('找不到这个账号，可能已被删除')
    const name = String(label ?? '').trim().slice(0, 40)
    if (!name) throw new Error('备注不能为空')
    account.label = name
    await writeStore(store)
  })
}

export function clearOAuthAccounts(provider: string): Promise<Result> {
  return mutate(provider, async (store, id) => {
    await updateAuthFile(async (auth) => {
      delete store.providers[id]
      await writeStore(store)
      const hadCredential = id in auth
      delete auth[id]
      return { write: hadCredential, result: undefined }
    })
  })
}

export function oauthAccountTargets(provider: OAuthAccountProvider): Promise<OAuthAccountTarget[]> {
  return serial(async () => {
    const store = await readStore()
    const current = await readAuthEntry(provider)
    const active = isCredential(current) ? await upsert(store, provider, current) : undefined
    if (active) await writeStore(store)
    return (store.providers[provider] ?? []).map((a) => ({ ...view(a, active?.key), credential: a.credential }))
  })
}
