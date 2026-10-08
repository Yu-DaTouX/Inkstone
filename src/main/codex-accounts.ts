/**
 * 砚里的多个 ChatGPT（Codex）账号。
 *
 * pi 只认 auth.json 里的一条 `openai-codex` 凭证，所以多账号由宿主保存其余账号的凭证副本，
 * 切换时把目标账号写回那一条。每个账号都在砚里单独 OAuth 登录（`oauth.ts`），令牌家族独立；
 * 不导入 Codex CLI 的登录 —— 共用 refresh token 会让一边刷新后另一边掉线。
 *
 * 不变量：
 *   · 当前账号的真源永远是 auth.json（pi 会刷新它）；这里的副本只是上次看到的版本。
 *   · 会覆盖 auth.json 的操作（切换、添加账号）之前，先把当前凭证收回副本，不能弄丢。
 *   · 改 auth.json 持 `auth.json.lock`（与 pi 同一把锁）。
 *   · 非当前账号的令牌只有砚在用，过期时由这里刷新并立刻保存轮换后的 refresh token。
 *   · 凭证不出主进程；渲染端只拿到 `CodexAccountView`。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { readAuthEntry, updateAuthFile } from './credentials'
import { refreshCodexCredential, type CodexOAuthCredential } from './oauth'
import { chatGptIdentity, type CodexAccountView } from '../shared/account-quota'

const STORE_FILE = join(YAN_DIR, 'codex-accounts.json')
const PROVIDER = 'openai-codex'
/** 离过期不到这么久就当已过期（请求路上过期一样会 401）。 */
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
  /** 可直接用于请求的凭证；当前账号已过期时为 undefined（等 pi 刷新）。 */
  credential?: CodexOAuthCredential
  /** 拿不到可用凭证的原因 */
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

/* 同一进程里的读改写串行，免得切换与额度刷新同时改副本文件。 */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function readStore(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, 'utf8')) as Partial<Store>
    const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((a): a is StoredAccount => !!a && typeof a.key === 'string' && isCodexCredential(a.credential)) : []
    return { version: 1, accounts }
  } catch {
    return { version: 1, accounts: [] }
  }
}

/** 先写临时文件再改名：写到一半崩溃也不会留下半个 JSON（里面是登录凭证）。 */
async function writeStore(store: Store): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, STORE_FILE)
}

/** 把一份凭证并进副本：同一账号只留一条，凭证取更晚过期的那份。返回账号 key。 */
function upsert(store: Store, credential: CodexOAuthCredential): string | undefined {
  const id = identityOf(credential)
  if (!id.key) return undefined
  const existing = store.accounts.find((a) => a.key === id.key)
  if (!existing) {
    store.accounts.push({ key: id.key, email: id.email, plan: id.plan, credential, savedAt: Date.now() })
  } else if (existing.credential.access !== credential.access && Number(credential.expires) >= Number(existing.credential.expires)) {
    Object.assign(existing, { email: id.email ?? existing.email, plan: id.plan ?? existing.plan, credential, savedAt: Date.now() })
  }
  return id.key
}

async function activeCredential(): Promise<CodexOAuthCredential | undefined> {
  const entry = await readAuthEntry(PROVIDER)
  return isCodexCredential(entry) ? entry : undefined
}

/**
 * 把 auth.json 里的当前账号收进副本，返回它的 key。
 * 在登录新账号（会覆盖 auth.json）之前、之后各调一次。
 */
export function captureActiveCodexAccount(): Promise<string | undefined> {
  return serial(async () => {
    const current = await activeCredential()
    if (!current) return undefined
    const store = await readStore()
    const before = JSON.stringify(store)
    const key = upsert(store, current)
    if (JSON.stringify(store) !== before) await writeStore(store)
    return key
  })
}

export async function listCodexAccounts(labels: Record<string, string> = {}): Promise<CodexAccountView[]> {
  const activeKey = await captureActiveCodexAccount()
  const store = await readStore()
  return store.accounts.map((a) => ({ key: a.key, email: a.email, plan: a.plan, label: labels[a.key], active: a.key === activeKey }))
}

/**
 * 切到另一个保存的账号：持锁读出当前凭证收回副本，再把目标凭证写进 auth.json。
 * 调用方随后重启 pi（等当前回合结束），新回合就用新账号。
 */
export function switchCodexAccount(key: string): Promise<{ ok: boolean; error?: string }> {
  return serial(async () => {
    const store = await readStore()
    if (!store.accounts.some((a) => a.key === key)) return { ok: false, error: '没有找到这个账号，可能已被移除' }
    try {
      await updateAuthFile(async (auth) => {
        const current = auth[PROVIDER]
        /* 先把当前凭证（可能刚被 pi 刷新过）落进副本，再覆盖 auth.json：中途失败也不丢账号 */
        if (isCodexCredential(current)) {
          upsert(store, current)
          await writeStore(store)
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

/** 移除一个保存的账号；它是当前账号时同时从 auth.json 退出登录。 */
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

/**
 * 查额度用：每个保存的账号配一份能用的凭证。
 * 当前账号用 auth.json 里的（过期就等 pi 刷新，宿主不抢着刷）；其余账号过期时在这里刷新并保存。
 */
export function codexAccountTargets(): Promise<CodexAccountTarget[]> {
  return serial(async () => {
    const current = await activeCredential()
    const store = await readStore()
    const before = JSON.stringify(store)
    const activeKey = current ? upsert(store, current) : undefined
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
        account.credential = await refreshCodexCredential(account.credential.refresh)
        account.savedAt = Date.now()
        /* refresh token 已轮换：立刻落盘，不等循环结束 */
        await writeStore(store)
        targets.push({ ...base, credential: account.credential })
      } catch (e) {
        targets.push({ ...base, problem: e instanceof Error ? e.message : String(e) })
      }
    }
    if (JSON.stringify(store) !== before) await writeStore(store)
    return targets
  })
}
