import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import type { Entry, ZipFile } from 'yauzl'
import type { ModDependencyRef, ModMetaKind } from '../../shared/mods-api.ts'
import { boolOf, parseToml, tableArray, textOf, type TomlTable } from './toml.ts'

const MAX_META_BYTES = 512 * 1024
export const MAX_ICON_BYTES = 256 * 1024
const MAX_NESTED_JARS = 40
const PREFERRED_ICON_SIZE = 64

export interface JarModInfo {
  kind: ModMetaKind | null
  modId: string | null
  name: string
  version: string | null
  description: string | null
  mcRange: string | null
  dependencies: ModDependencyRef[]
  provides: string[]
  nestedIds: string[]
  iconPath: string | null
  icon: Buffer | null
}

interface RawMeta {
  kind: ModMetaKind
  modId: string | null
  name: string | null
  version: string | null
  description: string | null
  iconCandidates: string[]
  mcRange: string | null
  dependencies: ModDependencyRef[]
  provides: string[]
}

const EMPTY: JarModInfo = {
  kind: null,
  modId: null,
  name: '',
  version: null,
  description: null,
  mcRange: null,
  dependencies: [],
  provides: [],
  nestedIds: [],
  iconPath: null,
  icon: null
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  return null
}

export function pickIconEntry(icon: unknown): string | null {
  if (typeof icon === 'string' && icon.trim()) return icon.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!icon || typeof icon !== 'object') return null
  const sized = Object.entries(icon as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([size, path]) => ({ size: Number(size), path: path.replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((entry) => Number.isFinite(entry.size))
    .sort((a, b) => Math.abs(a.size - PREFERRED_ICON_SIZE) - Math.abs(b.size - PREFERRED_ICON_SIZE))
  return sized[0]?.path ?? null
}

function dependencyList(value: unknown, kind: 'depends' | 'breaks' = 'depends'): ModDependencyRef[] {
  const out: ModDependencyRef[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        out.push({ modId: item[0], required: kind === 'depends', versionRange: typeof item[1] === 'string' ? item[1] : null, kind })
        continue
      }
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const modId = text(record.id ?? record.modId)
      if (!modId) continue
      const range = text(record.versions ?? record.version ?? record.versionRange)
      out.push({ modId, required: kind === 'depends' && record.optional !== true, versionRange: range, kind })
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [modId, range] of Object.entries(value as Record<string, unknown>)) {
      out.push({ modId, required: kind === 'depends', versionRange: typeof range === 'string' ? range : null, kind })
    }
  }
  return out
}

function mergeDependencies(depends: ModDependencyRef[], breaks: ModDependencyRef[]): ModDependencyRef[] {
  const out = [...depends]
  for (const item of breaks) {
    if (!out.some((existing) => existing.modId === item.modId)) out.push(item)
  }
  return out
}

function fabricMeta(json: Record<string, unknown>): RawMeta {
  const depends = dependencyList(json.depends)
  const mc = depends.find((item) => item.modId === 'minecraft')
  const provides = Array.isArray(json.provides) ? json.provides.map((item) => String(item)) : []
  return {
    kind: 'fabric',
    modId: text(json.id),
    name: text(json.name) ?? text(json.id),
    version: text(json.version),
    description: text(json.description),
    iconCandidates: [pickIconEntry(json.icon)].filter((item): item is string => !!item),
    mcRange: mc?.versionRange ?? null,
    dependencies: mergeDependencies(
      depends.filter((item) => item.modId !== 'minecraft'),
      dependencyList(json.breaks, 'breaks').filter((item) => item.modId !== 'minecraft')
    ),
    provides
  }
}

function quiltMeta(json: Record<string, unknown>): RawMeta {
  const loader = (json.quilt_loader ?? {}) as Record<string, unknown>
  const metadata = (loader.metadata ?? {}) as Record<string, unknown>
  const depends = dependencyList(loader.depends ?? json.depends)
  const mc = depends.find((item) => item.modId === 'minecraft')
  const provides = Array.isArray(loader.provides)
    ? loader.provides.map((item) => (typeof item === 'string' ? item : text((item as Record<string, unknown>)?.id))).filter((item): item is string => !!item)
    : []
  return {
    kind: 'quilt',
    modId: text(loader.id) ?? text(json.id),
    name: text(metadata.name) ?? text(loader.id),
    version: text(loader.version) ?? text(json.version),
    description: text(metadata.description),
    iconCandidates: [pickIconEntry(metadata.icon)].filter((item): item is string => !!item),
    mcRange: mc?.versionRange ?? null,
    dependencies: mergeDependencies(
      depends.filter((item) => item.modId !== 'minecraft'),
      dependencyList(loader.breaks ?? json.breaks, 'breaks').filter((item) => item.modId !== 'minecraft')
    ),
    provides
  }
}

function tomlDependencies(kind: 'forge' | 'neoforge', table: TomlTable, modId: string): ModDependencyRef[] {
  const root = table.dependencies
  const groups = root && typeof root === 'object' && !Array.isArray(root) ? (root as TomlTable) : {}
  const own = tableArray(groups[modId])
  const all = own.length > 0 ? own : Object.values(groups).flatMap((value) => tableArray(value))
  const out: ModDependencyRef[] = []
  for (const dep of all) {
    const depId = textOf(dep.modId)
    if (!depId) continue
    const type = textOf(dep.type)
    const mandatory = boolOf(dep.mandatory)
    const incompatible = kind === 'neoforge' && type === 'incompatible'
    const required = incompatible ? false : kind === 'neoforge' ? type !== 'optional' && type !== 'discouraged' && mandatory !== false : mandatory !== false
    out.push({ modId: depId, required, versionRange: textOf(dep.versionRange), kind: incompatible ? 'breaks' : 'depends' })
  }
  return out
}

function tomlMeta(kind: 'forge' | 'neoforge', raw: string): RawMeta {
  let table: TomlTable = {}
  try {
    table = parseToml(raw)
  } catch {
    table = {}
  }
  const mods = tableArray(table.mods)
  const primary = mods[0] ?? {}
  const modId = textOf(primary.modId) ?? ''
  const dependencies = tomlDependencies(kind, table, modId)
  const mc = dependencies.find((item) => item.modId === 'minecraft')
  const logo = textOf(primary.logoFile)
  return {
    kind,
    modId: modId || null,
    name: textOf(primary.displayName) ?? (modId || null),
    version: textOf(primary.version),
    description: textOf(primary.description),
    iconCandidates: [logo].filter((item): item is string => !!item).map((item) => item.replace(/\\/g, '/').replace(/^\/+/, '')),
    mcRange: mc?.versionRange ?? null,
    dependencies: dependencies.filter((item) => item.modId !== 'minecraft'),
    provides: mods.slice(1).map((item) => textOf(item.modId)).filter((item): item is string => !!item)
  }
}

function legacyMeta(raw: string): RawMeta {
  let list: unknown[] = []
  try {
    const parsed = JSON.parse(raw) as unknown
    const holder = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    list = Array.isArray(parsed) ? parsed : Array.isArray(holder?.modList) ? (holder.modList as unknown[]) : []
  } catch {
    list = []
  }
  const first = (list[0] ?? {}) as Record<string, unknown>
  const required = Array.isArray(first.requiredMods) ? first.requiredMods : Array.isArray(first.dependencies) ? first.dependencies : []
  const dependencies: ModDependencyRef[] = required
    .filter((item): item is string => typeof item === 'string')
    .map((item) => {
      const [modId, range] = item.split('@')
      return { modId: modId.trim(), required: true, versionRange: range?.trim() ?? null, kind: 'depends' }
    })
  const modId = text(first.modid) ?? text(first.modId)
  return {
    kind: 'legacy',
    modId,
    name: text(first.name) ?? modId,
    version: text(first.version),
    description: text(first.description),
    iconCandidates: [text(first.logoFile)].filter((item): item is string => !!item).map((item) => item.replace(/\\/g, '/').replace(/^\/+/, '')),
    mcRange: null,
    dependencies: dependencies.filter((item) => item.modId !== 'minecraft'),
    provides: []
  }
}

function parseMetaEntry(name: string, text: string): RawMeta | null {
  const lower = name.toLowerCase()
  try {
    if (lower === 'fabric.mod.json') return fabricMeta(JSON.parse(text) as Record<string, unknown>)
    if (lower === 'quilt.mod.json') return quiltMeta(JSON.parse(text) as Record<string, unknown>)
    if (lower === 'meta-inf/neoforge.mods.toml') return tomlMeta('neoforge', text)
    if (lower === 'meta-inf/mods.toml') return tomlMeta('forge', text)
    if (lower === 'mcmod.info') return legacyMeta(text)
  } catch {
    return null
  }
  return null
}

const META_ENTRIES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'mcmod.info']

function isPng(buffer: Buffer | undefined): buffer is Buffer {
  return !!buffer && buffer.length >= 8 && buffer.length <= MAX_ICON_BYTES && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
}

function findEntry(entries: Entry[], name: string): Entry | undefined {
  return entries.find((entry) => entry.fileName.toLowerCase() === name.toLowerCase())
}

async function readSmall(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer | null> {
  if (entry.uncompressedSize > limit) return null
  return readEntry(zip, entry)
}

function iconCandidates(candidates: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    out.push(normalized)
  }
  return out
}

async function nestedMods(zip: ZipFile, entries: Entry[]): Promise<{ ids: string[]; icon: Buffer | null }> {
  const ids: string[] = []
  let icon: Buffer | null = null
  const jars = entries.filter((entry) => /^META-INF\/jars\/.+\.jar$/i.test(entry.fileName)).slice(0, MAX_NESTED_JARS)
  for (const entry of jars) {
    if (entry.uncompressedSize > 32 * 1024 * 1024) continue
    const buffer = await readEntry(zip, entry)
    const inner = await open(buffer, { autoClose: false })
    try {
      const innerEntries = await readAllEntries(inner)
      for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
        const meta = findEntry(innerEntries, name)
        if (!meta) continue
        const raw = (await readSmall(inner, meta, MAX_META_BYTES))?.toString('utf8')
        if (!raw) continue
        const parsed = name === 'fabric.mod.json' ? fabricMeta(JSON.parse(raw) as Record<string, unknown>) : quiltMeta(JSON.parse(raw) as Record<string, unknown>)
        if (parsed.modId) ids.push(parsed.modId)
        if (!icon) icon = await iconFromZip(inner, innerEntries, parsed.iconCandidates)
      }
    } catch {
      continue
    } finally {
      inner.close()
    }
  }
  return { ids, icon }
}

async function iconFromZip(zip: ZipFile, entries: Entry[], candidates: string[]): Promise<Buffer | null> {
  for (const path of iconCandidates(candidates)) {
    const entry = findEntry(entries, path)
    if (!entry) continue
    const buffer = await readSmall(zip, entry, MAX_ICON_BYTES)
    if (isPng(buffer ?? undefined)) return buffer
  }
  return null
}

export async function readJarMod(source: string | Buffer): Promise<JarModInfo> {
  let zip: ZipFile
  try {
    zip = await open(source, { autoClose: false })
  } catch {
    return { ...EMPTY }
  }
  try {
    const entries = await readAllEntries(zip)
    let meta: RawMeta | null = null
    for (const name of META_ENTRIES) {
      const entry = findEntry(entries, name)
      if (!entry) continue
      const raw = await readSmall(zip, entry, MAX_META_BYTES)
      if (!raw) continue
      const parsed = parseMetaEntry(name, raw.toString('utf8'))
      if (parsed) {
        meta = parsed
        break
      }
    }
    const nested = await nestedMods(zip, entries)
    if (!meta) {
      return {
        ...EMPTY,
        nestedIds: [...new Set(nested.ids)],
        icon: nested.icon
      }
    }
    const icon = (await iconFromZip(zip, entries, meta.iconCandidates)) ?? nested.icon
    return {
      kind: meta.kind,
      modId: meta.modId,
      name: meta.name ?? meta.modId ?? '',
      version: meta.version,
      description: meta.description,
      mcRange: meta.mcRange,
      dependencies: meta.dependencies,
      provides: [...new Set(meta.provides)],
      nestedIds: [...new Set(nested.ids.filter((id) => id !== meta.modId))],
      iconPath: meta.iconCandidates[0] ?? null,
      icon
    }
  } catch {
    return { ...EMPTY }
  } finally {
    zip.close()
  }
}
