import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { readAuth, readAuthEntry, updateAuthFile, validProviderId } from './credentials'
import { CURRENT_KEY_ID, poolView, withCurrentKey, type ApiKeyPools, type StoredApiKey } from '../shared/api-keys'

const STORE_FILE = join(YAN_DIR, 'api-keys.json')
const LABEL_MAX = 40

interface Store {
  version: 1
  providers: Record<string, StoredApiKey[]>
}

type Result = { ok: boolean; error?: string }

let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function isStoredKey(v: unknown): v is StoredApiKey {
  const k = v as Partial<StoredApiKey> | null
  return !!k && typeof k.id === 'string' && typeof k.key === 'string' && !!k.key && typeof k.label === 'string'
}

async function readStore(): Promise<Store> {
  let text: string
  try {
    text = await readFile(STORE_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, providers: {} }
    throw error
  }
  let raw: Partial<Store> | null = null
  try {
    raw = JSON.parse(text) as Partial<Store>
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object' || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
    await copyFile(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}.bak`).catch(() => undefined)
    throw new Error(`API key 列表文件格式无效；为保护已保存的 key，已拒绝写入：${STORE_FILE}`)
  }
  const providers: Record<string, StoredApiKey[]> = {}
  for (const [id, list] of Object.entries(raw.providers)) {
    if (validProviderId(id) && Array.isArray(list)) providers[id] = list.filter(isStoredKey)
  }
  return { version: 1, providers }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, STORE_FILE)
}

function apiKeyOf(entry: unknown): string | undefined {
  const e = entry as { type?: string; key?: unknown } | null
  return e && e.type === 'api_key' && typeof e.key === 'string' && e.key.trim() ? e.key.trim() : undefined
}

async function currentKey(provider: string): Promise<string | undefined> {
  return apiKeyOf(await readAuthEntry(provider))
}

const OAUTH_IN_SLOT = '当前订阅登录尚未安全保存或已发生变化，已取消 key 操作；请重试，避免覆盖未保存的账号'

function guardSlot(data: Record<string, unknown>, provider: string, preservedOAuth?: unknown): void {
  const e = data[provider] as { type?: string } | null | undefined
  if (e?.type === 'oauth' && preservedOAuth && JSON.stringify(e) === JSON.stringify(preservedOAuth)) return
  if (e && typeof e === 'object' && e.type && e.type !== 'api_key') throw new Error(OAUTH_IN_SLOT)
}

function cleanLabel(label: unknown): string {
  return typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : ''
}

async function run(fn: () => Promise<void>, fallback: string): Promise<Result> {
  try {
    await serial(fn)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : fallback }
  }
}

function checkProvider(provider: string): void {
  if (!validProviderId(provider)) throw new Error('provider 名称无效')
}

export async function listApiKeyPools(): Promise<ApiKeyPools> {
  const store = await readStore()
  const auth = await readAuth()
  const out: ApiKeyPools = {}
  const ids = new Set([...Object.keys(store.providers), ...Object.keys(auth).filter((id) => validProviderId(id) && apiKeyOf(auth[id]))])
  for (const id of ids) {
    const view = poolView(store.providers[id] ?? [], apiKeyOf(auth[id]))
    if (view.length) out[id] = view
  }
  return out
}

export function captureActiveApiKey(provider: string): Promise<Result> {
  return run(async () => {
    checkProvider(provider)
    const current = await currentKey(provider)
    if (!current) return
    const store = await readStore()
    store.providers[provider] = withCurrentKey(store.providers[provider] ?? [], current, randomUUID)
    await writeStore(store)
  }, '无法保存当前 API key')
}

export function addApiKey(provider: string, key: string, label?: string, preservedOAuth?: unknown): Promise<Result> {
  return run(async () => {
    checkProvider(provider)
    const value = String(key ?? '').trim()
    if (!value) throw new Error('API key 不能为空')
    guardSlot(await readAuth(), provider, preservedOAuth)
    const store = await readStore()
    const list = withCurrentKey(store.providers[provider] ?? [], await currentKey(provider), randomUUID)
    const existing = list.find((k) => k.key === value)
    const name = cleanLabel(label)
    if (existing) {
      if (name) existing.label = name
    } else {
      list.push({ id: randomUUID(), label: name || `Key ${list.length + 1}`, key: value, addedAt: Date.now() })
    }
    store.providers[provider] = list
    await writeStore(store)
    await updateAuthFile((data) => {
      guardSlot(data, provider, preservedOAuth)
      data[provider] = { type: 'api_key', key: value }
      return { write: true, result: undefined }
    })
  }, '保存失败')
}

export function switchApiKey(provider: string, id: string, preservedOAuth?: unknown): Promise<Result> {
  return run(async () => {
    checkProvider(provider)
    if (id === CURRENT_KEY_ID) return
    const store = await readStore()
    const target = store.providers[provider]?.find((k) => k.id === id)
    if (!target) throw new Error('找不到这个 key，可能已被删除')
    await updateAuthFile(async (data) => {
      guardSlot(data, provider, preservedOAuth)
      const current = apiKeyOf(data[provider])
      if (current === target.key) return { write: false, result: undefined }
      store.providers[provider] = withCurrentKey(store.providers[provider] ?? [], current, randomUUID)
      await writeStore(store)
      data[provider] = { type: 'api_key', key: target.key }
      return { write: true, result: undefined }
    })
  }, '切换失败')
}

export function renameApiKey(provider: string, id: string, label: string): Promise<Result> {
  return run(async () => {
    checkProvider(provider)
    const name = cleanLabel(label)
    if (!name) throw new Error('备注不能为空')
    const store = await readStore()
    const current = await currentKey(provider)
    let list = store.providers[provider] ?? []
    let target = list.find((k) => k.id === id)
    if (!target && id === CURRENT_KEY_ID && current) {
      list = withCurrentKey(list, current, randomUUID)
      target = list.find((k) => k.key === current)
    }
    if (!target) throw new Error('找不到这个 key，可能已被删除')
    target.label = name
    store.providers[provider] = list
    await writeStore(store)
  }, '保存失败')
}

export async function removeApiKey(provider: string, id: string): Promise<Result & { wasActive: boolean }> {
  let wasActive = false
  const result = await run(async () => {
    checkProvider(provider)
    const store = await readStore()
    await updateAuthFile(async (data) => {
      const current = apiKeyOf(data[provider])
      const list = withCurrentKey(store.providers[provider] ?? [], current, randomUUID)
      const target = id === CURRENT_KEY_ID ? list.find((k) => k.key === current) : list.find((k) => k.id === id)
      if (!target) throw new Error('找不到这个 key，可能已被删除')
      wasActive = target.key === current
      store.providers[provider] = list.filter((k) => k.id !== target.id)
      if (!store.providers[provider].length) delete store.providers[provider]
      await writeStore(store)
      if (wasActive) delete data[provider]
      return { write: wasActive, result: undefined }
    })
  }, '删除失败')
  return { ...result, wasActive }
}

export function clearApiKeys(provider: string): Promise<Result> {
  return run(async () => {
    checkProvider(provider)
    const store = await readStore()
    if (!(provider in store.providers)) return
    delete store.providers[provider]
    await writeStore(store)
  }, '删除失败')
}
