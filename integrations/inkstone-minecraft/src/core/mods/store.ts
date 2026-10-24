import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModDependencyRef, ModMetaKind } from '../../shared/mods-api.ts'
import { readJarMod } from './metadata.ts'

const CACHE_VERSION = 1

export interface CachedMeta {
  kind: ModMetaKind | null
  modId: string | null
  name: string
  version: string | null
  description: string | null
  mcRange: string | null
  dependencies: ModDependencyRef[]
  provides: string[]
  nestedIds: string[]
  iconKey: string | null
  missingMeta: boolean
}

export interface ModrinthRecord {
  projectId: string
  title: string | null
  iconUrl: string | null
}

interface CacheData {
  version: number
  metas: Record<string, CachedMeta>
  modrinth: Record<string, ModrinthRecord>
}

function emptyCache(): CacheData {
  return { version: CACHE_VERSION, metas: {}, modrinth: {} }
}

function isMeta(value: unknown): value is CachedMeta {
  return !!value && typeof value === 'object' && typeof (value as CachedMeta).name === 'string'
}

function normalize(raw: unknown): CacheData {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (data.version !== CACHE_VERSION) return emptyCache()
  const metas: Record<string, CachedMeta> = {}
  const modrinth: Record<string, ModrinthRecord> = {}
  const metasRaw = (data.metas ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(metasRaw)) if (isMeta(value)) metas[key] = value
  const modrinthRaw = (data.modrinth ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(modrinthRaw)) {
    const record = value as Partial<ModrinthRecord> | null
    if (record && typeof record.projectId === 'string') modrinth[key] = { projectId: record.projectId, title: record.title ?? null, iconUrl: record.iconUrl ?? null }
  }
  return { version: CACHE_VERSION, metas, modrinth }
}

export class ModStore {
  readonly iconsDir: string
  private readonly file: string
  private data: CacheData | null = null
  private saving: Promise<void> | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'mods-cache.json')
    this.iconsDir = join(dataDir, 'icons')
  }

  async load(): Promise<CacheData> {
    if (this.data) return this.data
    try {
      this.data = normalize(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      this.data = emptyCache()
    }
    return this.data
  }

  async save(): Promise<void> {
    if (this.saving) return this.saving
    this.saving = (async () => {
      try {
        const data = await this.load()
        await mkdir(dirname(this.file), { recursive: true })
        const temp = `${this.file}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(data)}\n`, 'utf8')
        await rename(temp, this.file)
      } catch {
        return
      } finally {
        this.saving = null
      }
    })()
    return this.saving
  }

  modrinthOf(sha1: string): ModrinthRecord | null {
    return this.data?.modrinth[sha1] ?? null
  }

  async rememberModrinth(sha1: string, record: ModrinthRecord): Promise<void> {
    const data = await this.load()
    data.modrinth[sha1] = record
    await this.save()
  }

  private async writeIcon(buffer: Buffer): Promise<string> {
    const key = createHash('sha1').update(buffer).digest('hex')
    const path = join(this.iconsDir, `${key}.png`)
    await mkdir(this.iconsDir, { recursive: true })
    await writeFile(path, buffer)
    return key
  }

  async iconDataUrl(key: string | null): Promise<string | null> {
    if (!key) return null
    try {
      const buffer = await readFile(join(this.iconsDir, `${key}.png`))
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch {
      return null
    }
  }

  async metaFor(sha1: string, path: string): Promise<CachedMeta> {
    const data = await this.load()
    const hit = data.metas[sha1]
    if (hit) return hit
    const jar = await readJarMod(path)
    const meta: CachedMeta = {
      kind: jar.kind,
      modId: jar.modId,
      name: jar.name || '',
      version: jar.version,
      description: jar.description,
      mcRange: jar.mcRange,
      dependencies: jar.dependencies,
      provides: jar.provides,
      nestedIds: jar.nestedIds,
      iconKey: jar.icon ? await this.writeIcon(jar.icon) : null,
      missingMeta: !jar.kind
    }
    data.metas[sha1] = meta
    await this.save()
    return meta
  }
}
