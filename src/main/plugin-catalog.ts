import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  BUILTIN_PLUGIN_CATALOG,
  PLUGIN_CATALOG_URL,
  normalizePluginCatalog,
  type PluginCatalogView
} from '../shared/plugin-catalog'

const CACHE_FILE = join(YAN_DIR, 'plugin-catalog.json')
const FRESH_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 256 * 1024

interface CachedCatalog {
  fetchedAt: number
  body: unknown
}

let memory: PluginCatalogView | null = null
let inflight: Promise<PluginCatalogView> | null = null

function catalogUrl(): string {
  const override = process.env.YAN_PLUGIN_CATALOG_URL
  return override && /^https?:\/\//.test(override) ? override : PLUGIN_CATALOG_URL
}

async function readCache(): Promise<PluginCatalogView | null> {
  try {
    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Partial<CachedCatalog>
    const catalog = normalizePluginCatalog(cached.body)
    if (!catalog || typeof cached.fetchedAt !== 'number') return null
    return { source: 'cache', updatedAt: catalog.updatedAt, fetchedAt: cached.fetchedAt, plugins: catalog.plugins }
  } catch {
    return null
  }
}

async function writeCache(body: unknown, fetchedAt: number): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${CACHE_FILE}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify({ fetchedAt, body }), 'utf8')
  await rename(temp, CACHE_FILE)
}

async function fetchRemote(request: typeof fetch): Promise<{ body: unknown; view: PluginCatalogView }> {
  const response = await request(catalogUrl(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
    cache: 'no-store'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty response')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Error('catalog too large')
    }
    chunks.push(value)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  const catalog = normalizePluginCatalog(body)
  if (!catalog) throw new Error('unsupported catalog schema')
  const fetchedAt = Date.now()
  return { body, view: { source: 'remote', updatedAt: catalog.updatedAt, fetchedAt, plugins: catalog.plugins } }
}

export async function loadPluginCatalog(refresh = false, request: typeof fetch = fetch): Promise<PluginCatalogView> {
  if (!refresh && memory?.fetchedAt && Date.now() - memory.fetchedAt < FRESH_MS) return memory
  if (inflight) return inflight
  inflight = (async () => {
    const cached = await readCache()
    if (!refresh && cached?.fetchedAt && Date.now() - cached.fetchedAt < FRESH_MS) {
      memory = cached
      return cached
    }
    try {
      const remote = await fetchRemote(request)
      await writeCache(remote.body, remote.view.fetchedAt ?? Date.now()).catch(() => undefined)
      memory = remote.view
      return remote.view
    } catch (error) {
      console.warn('[plugin-catalog] 远程目录不可用，改用本地副本：', error instanceof Error ? error.message : String(error))
      const local = cached ?? memory
      return local && local.updatedAt >= BUILTIN_PLUGIN_CATALOG.updatedAt ? local : BUILTIN_PLUGIN_CATALOG
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}
