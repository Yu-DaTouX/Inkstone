import type { MarketSearchResult } from '../shared/plugin-market'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const HERMES_PLUGIN_FILES = ['plugin.yaml', '__init__.py', 'client.py', 'approvals.py', 'connect.py', 'README.md']

export async function exportHermesPlugin(source: string, parent: string): Promise<string> {
  const target = join(parent, 'inkstone')
  // Atomic exclusive creation: never overwrite an installed plugin or follow a target symlink.
  try { await mkdir(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标目录已有 inkstone，请选择其他目录，避免覆盖现有插件')
    throw error
  }
  for (const file of HERMES_PLUGIN_FILES) await copyFile(join(source, file), join(target, file))
  return target
}

/** Publisher-declared links are shown and opened externally, so only plain https URLs pass. */
function httpsLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/\.git$/, ''))
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

const cache = new Map<string, { expires: number; result: MarketSearchResult }>()
const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/

/** Read npm metadata only. Installation remains an explicit pi package action. */
export async function searchPiPackages(query: string, offset = 0, request: typeof fetch = fetch): Promise<MarketSearchResult> {
  const text = query.trim().slice(0, 100)
  const from = Math.max(0, Math.min(10000, Math.floor(offset)))
  const key = `${text}:${from}`
  const hit = cache.get(key)
  if (request === fetch && hit && hit.expires > Date.now()) return hit.result
  try {
    const url = new URL('https://registry.npmjs.org/-/v1/search')
    url.searchParams.set('text', `keywords:pi-package ${text}`)
    url.searchParams.set('size', '24')
    url.searchParams.set('from', String(from))
    const response = await request(url, { signal: AbortSignal.timeout(12000), redirect: 'error' })
    if (!response.ok) throw new Error(`npm HTTP ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty catalog response')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Catalog response too large') }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!Array.isArray(body.objects) || !Number.isFinite(body.total)) throw new Error('Invalid catalog response')
    const entries = body.objects.slice(0, 24).flatMap((item: { package?: Record<string, unknown> }) => {
      const pkg = item?.package
      if (!pkg || typeof pkg.name !== 'string' || !NAME.test(pkg.name) || pkg.name.length > 214 ||
          !Array.isArray(pkg.keywords) || !pkg.keywords.includes('pi-package')) return []
      const publisher = pkg.publisher as { username?: unknown } | undefined
      const links = (pkg.links ?? {}) as { homepage?: unknown; repository?: unknown }
      const homepage = httpsLink(links.repository) ?? httpsLink(links.homepage)
      return [{ name: pkg.name, source: `npm:${pkg.name}`, version: String(pkg.version ?? '').slice(0, 80),
        description: String(pkg.description ?? '').slice(0, 1000), publisher: String(publisher?.username ?? '').slice(0, 100),
        npmUrl: `https://www.npmjs.com/package/${pkg.name}`, ...(homepage ? { homepage } : {}) }]
    })
    const result = { ok: true, entries, total: Math.max(0, body.total) }
    if (request === fetch) {
      if (cache.size >= 20) cache.delete(cache.keys().next().value!)
      cache.set(key, { result, expires: Date.now() + 300000 })
    }
    return result
  } catch (error) {
    return { ok: false, entries: [], total: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
