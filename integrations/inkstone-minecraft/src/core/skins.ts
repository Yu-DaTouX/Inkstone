import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, SkinInfo } from '../shared/api.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_SKIN_BYTES = 512 * 1024
const MAX_PROFILE_BYTES = 64 * 1024
const FRESH_MS = 6 * 60 * 60_000
const TIMEOUT_MS = 8000

export function defaultSlim(uuid: string): boolean {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return false
  const hilo = BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`)) ^ BigInt.asIntN(64, BigInt(`0x${hex.slice(16)}`))
  const hash = Number(BigInt.asIntN(32, hilo >> 32n) ^ BigInt.asIntN(32, hilo))
  return (hash & 1) === 1
}

export function profileUrl(account: Account): string | null {
  if (account.kind === 'microsoft') return `https://sessionserver.mojang.com/session/minecraft/profile/${account.uuid}`
  if (account.kind === 'yggdrasil' && account.server) return `${account.server.replace(/\/+$/, '')}/sessionserver/session/minecraft/profile/${account.uuid}`
  return null
}

export function parseTextures(profile: unknown): { url: string; slim: boolean } | null {
  const properties = (profile as { properties?: unknown })?.properties
  if (!Array.isArray(properties)) return null
  const textures = properties.find((item) => item && typeof item === 'object' && (item as { name?: unknown }).name === 'textures') as { value?: unknown } | undefined
  if (typeof textures?.value !== 'string') return null
  try {
    const decoded = JSON.parse(Buffer.from(textures.value, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: unknown; metadata?: { model?: unknown } } } }
    const skin = decoded.textures?.SKIN
    if (typeof skin?.url !== 'string') return null
    const url = skin.url.replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/')
    if (!/^https:\/\//i.test(url)) return null
    return { url, slim: skin.metadata?.model === 'slim' }
  } catch {
    return null
  }
}

async function fetchLimited(request: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const response = await request(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > limit) throw new Error('响应过大')
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > limit) throw new Error('响应过大')
  return body
}

interface CachedSkin {
  at: number
  slim: boolean
  hasSkin: boolean
}

export class SkinCache {
  private readonly dir: string
  private readonly request: typeof fetch
  private readonly inflight = new Map<string, Promise<SkinInfo>>()

  constructor(dir: string, request: typeof fetch = fetch) {
    this.dir = dir
    this.request = request
  }

  private key(account: Account): string {
    return createHash('sha256').update(account.id).digest('hex').slice(0, 32)
  }

  private async readCache(key: string): Promise<{ meta: CachedSkin; info: SkinInfo } | null> {
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as CachedSkin
      const png = meta.hasSkin ? await readFile(join(this.dir, `${key}.png`)) : null
      return { meta, info: { dataUrl: png ? `data:image/png;base64,${png.toString('base64')}` : null, slim: meta.slim === true } }
    } catch {
      return null
    }
  }

  private async writeCache(key: string, png: Buffer | null, slim: boolean): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    if (png) {
      await writeFile(`${join(this.dir, key)}.png.tmp`, png)
      await rename(`${join(this.dir, key)}.png.tmp`, join(this.dir, `${key}.png`))
    }
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify({ at: Date.now(), slim, hasSkin: !!png } satisfies CachedSkin))
  }

  get(account: Account): Promise<SkinInfo> {
    const url = profileUrl(account)
    if (!url) return Promise.resolve({ dataUrl: null, slim: defaultSlim(account.uuid) })
    const key = this.key(account)
    const running = this.inflight.get(key)
    if (running) return running
    const task = (async (): Promise<SkinInfo> => {
      const cached = await this.readCache(key)
      if (cached && Date.now() - cached.meta.at < FRESH_MS) return cached.info
      try {
        const profile = JSON.parse((await fetchLimited(this.request, url, MAX_PROFILE_BYTES)).toString('utf8')) as unknown
        const textures = parseTextures(profile)
        if (!textures) {
          await this.writeCache(key, null, defaultSlim(account.uuid))
          return { dataUrl: null, slim: defaultSlim(account.uuid) }
        }
        const png = await fetchLimited(this.request, textures.url, MAX_SKIN_BYTES)
        if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('皮肤不是 PNG')
        await this.writeCache(key, png, textures.slim)
        return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, slim: textures.slim }
      } catch {
        return cached?.info ?? { dataUrl: null, slim: defaultSlim(account.uuid) }
      }
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }
}
