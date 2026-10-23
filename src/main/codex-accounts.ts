import { constants as fsConstants } from 'node:fs'
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { readAuthEntry, updateAuthFile } from './credentials'
import { refreshCodexCredential, type CodexOAuthCredential } from './oauth'
import { chatGptIdentity, type ChatGptIdentity, type CodexAccountView } from '../shared/account-quota'

const STORE_FILE = join(YAN_DIR, 'codex-accounts.json')
const PROVIDER = 'openai-codex'
const EXPIRY_MARGIN_MS = 60_000

interface StoredAccount {
  key: string
  email?: string
  plan?: string
  credential: CodexOAuthCredential
  savedAt: number
}

interface Store {
  version: 1
  accounts: StoredAccount[]
}

export interface CodexAccountTarget {
  key: string
  email?: string
  plan?: string
  active: boolean
  credential?: CodexOAuthCredential
  problem?: 'expired' | string
}

function isCodexCredential(v: unknown): v is CodexOAuthCredential {
  const c = v as Partial<CodexOAuthCredential> | null
  return !!c && c.type === 'oauth' && typeof c.access === 'string' && typeof c.refresh === 'string' && typeof c.accountId === 'string'
}

function identityOf(credential: CodexOAuthCredential): ChatGptIdentity {
  return chatGptIdentity(credential.access, undefined, credential.accountId)
}

function sameAccount(account: StoredAccount, credential: CodexOAuthCredential): boolean {
  const a = identityOf(account.credential)
  const b = identityOf(credential)
  if (!a.accountId || a.accountId !== b.accountId) return false
  if (a.userId && b.userId) return a.userId === b.userId
  const email = a.email ?? account.email
  return !!email && !!b.email && email.toLowerCase() === b.email.toLowerCase()
}

const isExpired = (c: CodexOAuthCredential): boolean => !(Number(c.expires) > Date.now() + EXPIRY_MARGIN_MS)

let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function backupCorruptStore(): Promise<void> {
  await copyFile(STORE_FILE, `${STORE_FILE}.corrupt.bak`, fsConstants.COPYFILE_EXCL).catch(() => undefined)
}

async function readStore(): Promise<Store> {
  let text: string
  try {
    text = await readFile(STORE_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
    throw error
  }
  let raw: Partial<Store>
  try {
    raw = JSON.parse(text) as Partial<Store>
  } catch (error) {
    await backupCorruptStore()
    throw new Error(`账号凭证文件格式无效；为保护已有账号，已拒绝写入：${STORE_FILE}`)
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) {
    await backupCorruptStore()
    throw new Error(`账号凭证文件格式无效；为保护已有账号，已拒绝写入：${STORE_FILE}`)
  }
  const store: Store = { version: 1, accounts: [] }
  for (const account of raw.accounts) {
    if (!account || typeof account.key !== 'string' || !isCodexCredential(account.credential)) continue
    if (!upsert(store, account.credential, account).key) store.accounts.push(account)
  }
  return store
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, STORE_FILE)
}

function upsert(store: Store, credential: CodexOAuthCredential, saved?: StoredAccount): { key?: string; changed: boolean } {
  const id = identityOf(credential)
  if (!id.key) return { changed: false }
  const existing = store.accounts.find((a) => a.key === id.key || sameAccount(a, credential))
  const savedAt = saved?.savedAt ?? Date.now()
  if (!existing) {
    store.accounts.push({ key: id.key, email: id.email ?? saved?.email, plan: id.plan ?? saved?.plan, credential, savedAt })
    return { key: id.key, changed: true }
  }
  let changed = false
  if ((existing.credential.access !== credential.access || existing.credential.refresh !== credential.refresh) &&
      (Number(credential.expires) > Number(existing.credential.expires) ||
       (Number(credential.expires) === Number(existing.credential.expires) && savedAt >= existing.savedAt))) {
    Object.assign(existing, { key: id.key, email: id.email ?? saved?.email ?? existing.email, plan: id.plan ?? saved?.plan ?? existing.plan, credential, savedAt })
    changed = true
  }
  return { key: existing.key, changed }
}

async function activeCredential(): Promise<CodexOAuthCredential | undefined> {
  const entry = await readAuthEntry(PROVIDER)
  return isCodexCredential(entry) ? entry : undefined
}

export function captureActiveCodexAccount(): Promise<string | undefined> {
  return serial(async () => {
    const current = await activeCredential()
    if (!current) return undefined
    const store = await readStore()
    const saved = upsert(store, current)
    if (saved.changed) await writeStore(store)
    return saved.key
  })
}

export function listCodexAccounts(labels: Record<string, string> = {}): Promise<CodexAccountView[]> {
  return serial(async () => {
    const current = await activeCredential()
    const store = await readStore()
    const saved = current ? upsert(store, current) : undefined
    if (saved?.changed) await writeStore(store)
    return store.accounts.map((a) => ({ key: a.key, email: a.email, plan: a.plan, label: labels[a.key], active: a.key === saved?.key }))
  })
}

export function switchCodexAccount(key: string): Promise<{ ok: boolean; error?: string }> {
  return serial(async () => {
    try {
      const store = await readStore()
      if (!store.accounts.some((a) => a.key === key)) return { ok: false, error: '没有找到这个账号，可能已被移除' }
      await updateAuthFile(async (auth) => {
        const current = auth[PROVIDER]
        if (isCodexCredential(current)) {
          if (upsert(store, current).changed) await writeStore(store)
        }
        const target = store.accounts.find((a) => a.key === key)!
        auth[PROVIDER] = target.credential
        return { write: true, result: undefined }
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true }
  })
}

export function removeCodexAccount(key: string): Promise<{ ok: boolean; wasActive: boolean; error?: string }> {
  return serial(async () => {
    let wasActive = false
    try {
      const store = await readStore()
      await updateAuthFile(async (auth) => {
        const current = auth[PROVIDER]
        if (isCodexCredential(current)) upsert(store, current)
        const target = store.accounts.find((a) => a.key === key)
        if (!target) throw new Error('没有找到这个账号，可能已被移除')
        wasActive = isCodexCredential(current) && (identityOf(current).key === key || sameAccount(target, current))
        store.accounts = store.accounts.filter((a) => a.key !== key)
        await writeStore(store)
        if (wasActive) delete auth[PROVIDER]
        return { write: wasActive, result: undefined }
      })
      return { ok: true, wasActive }
    } catch (e) {
      return { ok: false, wasActive, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function clearCodexAccounts(): Promise<{ ok: boolean; error?: string }> {
  return serial(async () => {
    try {
      await readStore()
      await updateAuthFile(async (auth) => {
        await writeStore({ version: 1, accounts: [] })
        const hadCredential = PROVIDER in auth
        delete auth[PROVIDER]
        return { write: hadCredential, result: undefined }
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function codexAccountTargets(): Promise<CodexAccountTarget[]> {
  return serial(async () => {
    const current = await activeCredential()
    const store = await readStore()
    const saved = current ? upsert(store, current) : undefined
    let changed = saved?.changed ?? false
    const activeKey = saved?.key
    const targets: CodexAccountTarget[] = []
    for (const account of store.accounts) {
      const active = account.key === activeKey
      const base = { key: account.key, email: account.email, plan: account.plan, active }
      if (active) {
        targets.push(current && !isExpired(current) ? { ...base, credential: current } : { ...base, problem: 'expired' })
        continue
      }
      if (!isExpired(account.credential)) {
        targets.push({ ...base, credential: account.credential })
        continue
      }
      try {
        account.credential = await refreshCodexCredential(account.credential.refresh, account.credential.accountId)
        const identity = identityOf(account.credential)
        account.key = identity.key ?? account.key
        account.email = identity.email ?? account.email
        account.plan = identity.plan ?? account.plan
        account.savedAt = Date.now()
        changed = true
        targets.push({ ...base, key: account.key, email: account.email, plan: account.plan, credential: account.credential })
      } catch (e) {
        targets.push({ ...base, problem: e instanceof Error ? e.message : String(e) })
      }
    }
    if (changed) await writeStore(store)
    return targets
  })
}
