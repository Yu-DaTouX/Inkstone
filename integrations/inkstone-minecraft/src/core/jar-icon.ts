import { open, readAllEntries, readEntry } from '@xmcl/unzip'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_ICON_BYTES = 256 * 1024
const MAX_META_BYTES = 512 * 1024
const PREFERRED_SIZE = 64

export function isPng(buffer: Buffer | null | undefined): buffer is Buffer {
  return !!buffer && buffer.length <= MAX_ICON_BYTES && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

export function pickIconPath(icon: unknown): string | null {
  if (typeof icon === 'string' && icon) return icon
  if (!icon || typeof icon !== 'object') return null
  const sizes = Object.entries(icon as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Number.isFinite(Number(entry[0])))
    .sort((a, b) => Math.abs(Number(a[0]) - PREFERRED_SIZE) - Math.abs(Number(b[0]) - PREFERRED_SIZE))
  return sizes[0]?.[1] ?? null
}

export function iconFromToml(text: string): string | null {
  const match = /^\s*logoFile\s*=\s*["']([^"']+)["']/m.exec(text)
  return match ? match[1] : null
}

export function iconFromMcmodInfo(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { modList?: unknown })?.modList
    if (!Array.isArray(list)) return null
    const logo = list.map((item) => (item as { logoFile?: unknown })?.logoFile).find((value) => typeof value === 'string' && value)
    return typeof logo === 'string' ? logo : null
  } catch {
    return null
  }
}

export function normalizeEntryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

const META_READERS: Array<{ entry: string; icon(text: string): string | null }> = [
  { entry: 'fabric.mod.json', icon: (text) => pickIconPath((JSON.parse(text) as { icon?: unknown }).icon) },
  { entry: 'quilt.mod.json', icon: (text) => pickIconPath((JSON.parse(text) as { quilt_loader?: { metadata?: { icon?: unknown } } }).quilt_loader?.metadata?.icon) },
  { entry: 'META-INF/neoforge.mods.toml', icon: iconFromToml },
  { entry: 'META-INF/mods.toml', icon: iconFromToml },
  { entry: 'mcmod.info', icon: iconFromMcmodInfo }
]

export async function readJarEntries(jarPath: string, wanted: string[]): Promise<Map<string, Buffer>> {
  const zip = await open(jarPath, { lazyEntries: true, autoClose: false })
  try {
    const entries = await readAllEntries(zip)
    const found = new Map<string, Buffer>()
    for (const name of wanted) {
      const entry = entries.find((item) => item.fileName === name)
      if (entry && entry.uncompressedSize <= MAX_META_BYTES) found.set(name, await readEntry(zip, entry))
    }
    return found
  } finally {
    zip.close()
  }
}

export async function jarIcon(jarPath: string, fallbackEntries: string[] = []): Promise<Buffer | null> {
  try {
    const meta = await readJarEntries(jarPath, META_READERS.map((reader) => reader.entry))
    const candidates: string[] = []
    for (const reader of META_READERS) {
      const text = meta.get(reader.entry)?.toString('utf8')
      if (!text) continue
      try {
        const path = reader.icon(text)
        if (path) candidates.push(normalizeEntryPath(path))
      } catch {
        continue
      }
    }
    candidates.push(...fallbackEntries)
    if (candidates.length === 0) return null
    const files = await readJarEntries(jarPath, candidates)
    for (const path of candidates) {
      const png = files.get(path)
      if (isPng(png)) return png
    }
    return null
  } catch {
    return null
  }
}
