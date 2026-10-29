import { fetchPublicPage, type PublicPageOptions } from './public-page'
import { normalizeReadUrl } from './page-types'

type IconResponse = Awaited<ReturnType<typeof fetchPublicPage>>
interface SiteIconDeps {
  fetch(url: string, signal: AbortSignal, options: PublicPageOptions): Promise<IconResponse>
  png(bytes: Uint8Array): Promise<string | null>
  now(): number
}

const defaults: SiteIconDeps = {
  fetch: (url, signal, options) => fetchPublicPage(url, signal, undefined, options),
  png: async (bytes) => {
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    const size = image.getSize()
    if (image.isEmpty() || size.width > 2048 || size.height > 2048) return null
    return image.resize({ width: 48, height: 48, quality: 'best' }).toDataURL()
  },
  now: Date.now
}

export function encodedSiteIcon(bytes: Uint8Array, contentType: string): string | null {
  const data = Buffer.from(bytes)
  if (data.length >= 22 && data.readUInt32LE(0) === 0x00010000) {
    const count = data.readUInt16LE(4)
    if (count < 1 || count > 32 || data.length < 6 + count * 16) return null
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16
      const size = data.readUInt32LE(entry + 8)
      const offset = data.readUInt32LE(entry + 12)
      if (!size || offset < 6 + count * 16 || offset + size > data.length) return null
    }
    return `data:image/x-icon;base64,${data.toString('base64')}`
  }
  if (contentType.includes('image/svg+xml') && data.length <= 64 * 1024) {
    const svg = data.toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/i.test(svg) || !/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return null
    return `data:image/svg+xml;base64,${data.toString('base64')}`
  }
  return null
}

export function siteIconCandidates(html: string, base: string): string[] {
  const candidates: { url: string; score: number }[] = []
  for (const match of html.matchAll(/<link\b[^>]{0,4096}>/gi)) {
    const attrs = new Map<string, string>()
    for (const attr of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(attr[1].toLowerCase(), (attr[2] ?? attr[3] ?? attr[4]).replace(/&amp;/gi, '&'))
    }
    const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attrs.get('href')
    if (!href || !rel.some((value) => value === 'icon' || value === 'apple-touch-icon')) continue
    try {
      const url = normalizeReadUrl(new URL(href, base).href)
      const png = /\.png(?:[?#]|$)/i.test(url) || attrs.get('type') === 'image/png'
      candidates.push({ url, score: png ? 3 : rel.includes('apple-touch-icon') ? 2 : 1 })
    } catch {}
  }
  return [...new Set(candidates.sort((a, b) => b.score - a.score).map((item) => item.url))].slice(0, 4)
}

export function createSiteIconLoader(deps: SiteIconDeps = defaults): (raw: string) => Promise<string | null> {
  const cache = new Map<string, { data: string | null; expires: number }>()
  const pending = new Map<string, Promise<string | null>>()
  const queue: (() => void)[] = []
  let active = 0
  let cachedChars = 0

  const image = async (url: string, signal: AbortSignal): Promise<string | null> => {
    try {
      const result = await deps.fetch(url, AbortSignal.any([signal, AbortSignal.timeout(1600)]), { maxBytes: 256 * 1024, accept: 'image/png,image/x-icon,image/webp,image/*;q=0.8' })
      if (/text\/|application\/(?:json|xml)/.test(result.contentType)) return null
      return encodedSiteIcon(result.body, result.contentType) ?? await deps.png(result.body)
    } catch { return null }
  }

  const load = async (origin: string): Promise<string | null> => {
    if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve))
    else active++
    try {
      const signal = AbortSignal.timeout(6500)
      const standard = await image(`${origin}/favicon.ico`, signal)
      if (standard) return standard
      const page = await deps.fetch(`${origin}/`, AbortSignal.any([signal, AbortSignal.timeout(2500)]), { maxBytes: 512 * 1024, accept: 'text/html' })
      if (!/html/.test(page.contentType)) return null
      for (const url of siteIconCandidates(new TextDecoder().decode(page.body), page.finalUrl)) {
        signal.throwIfAborted()
        const data = await image(url, signal)
        if (data) return data
      }
      return null
    } catch { return null }
    finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }

  return async (raw) => {
    let origin: string
    try { origin = new URL(normalizeReadUrl(raw)).origin } catch { return null }
    const cached = cache.get(origin)
    if (cached && cached.expires > deps.now()) {
      cache.delete(origin)
      cache.set(origin, cached)
      return cached.data
    }
    const existing = pending.get(origin)
    if (existing) return existing
    if (pending.size >= 64) return null
    const request = load(origin).then((data) => {
      cachedChars -= cache.get(origin)?.data?.length ?? 0
      cache.delete(origin)
      cache.set(origin, { data, expires: deps.now() + (data ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000) })
      cachedChars += data?.length ?? 0
      while (cache.size > 192 || cachedChars > 4 * 1024 * 1024) {
        const key = cache.keys().next().value!
        cachedChars -= cache.get(key)?.data?.length ?? 0
        cache.delete(key)
      }
      return data
    }).finally(() => pending.delete(origin))
    pending.set(origin, request)
    return request
  }
}
