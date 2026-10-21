import { constants as fsConstants } from 'node:fs'
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { readAuthEntry, updateAuthFile } from './credentials'
import { refreshCodexCredential, type CodexOAuthCredential } from './oauth'
import { chatGptIdentity, type CodexAccountView } from '../shared/account-quota'

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

function identityOf(credential: CodexOAuthCredential): { key?: string; email?: string; plan?: string } {
  const id = chatGptIdentity(credential.access, undefined, credential.accountId)
  return { key: id.key, email: id.email, plan: id.plan }
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
  const accounts = raw.accounts.filter((a): a is StoredAccount => !!a && typeof a.key === 'string' && isCodexCredential(a.credential))
  return { version: 1, accounts }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, STORE_FILE)
}

function upsert(store: Store, credential: CodexOAuthCredential): { key?: string; changed: boolean } {
  const id = identityOf(credential)
  if (!id.key) return { changed: false }
  const existing = store.accounts.find((a) => a.key === id.key)
  if (!existing) {
    store.accounts.push({ key: id.key, email: id.email, plan: id.plan, credential, savedAt: Date.now() })
    return { key: id.key, changed: true }
  }
  if (existing.credential.access !== credential.access && Number(credential.expires) >= Number(existing.credential.expires)) {
    Object.assign(existing, { email: id.email ?? existing.email, plan: id.plan ?? existing.plan, credential, savedAt: Date.now() })
    return { key: id.key, changed: true }
  }
  return { key: id.key, changed: false }
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

export async function listCodexAccounts(labels: Record<string, string> = {}): Promise<CodexAccountView[]> {
  const activeKey = await captureActiveCodexAccount()
  const store = await readStore()
  return store.accounts.map((a) => ({ key: a.key, email: a.email, plan: a.plan, label: labels[a.key], active: a.key === activeKey }))
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
    const store = await readStore()
    let wasActive = false
    try {
      await updateAuthFile((auth) => {
        const current = auth[PROVIDER]
        wasActive = isCodexCredential(current) && identityOf(current).key === key
        if (wasActive) delete auth[PROVIDER]
        return { write: wasActive, result: undefined }
      })
    } catch (e) {
      return { ok: false, wasActive, error: e instanceof Error ? e.message : String(e) }
    }
    store.accounts = store.accounts.filter((a) => a.key !== key)
    await writeStore(store)
    return { ok: true, wasActive }
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
        account.savedAt = Date.now()
        changed = true
        targets.push({ ...base, credential: account.credential })
      } catch (e) {
        targets.push({ ...base, problem: e instanceof Error ? e.message : String(e) })
      }
    }
    if (changed) await writeStore(store)
    return targets
  })
}
