import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LoaderKind } from '../../shared/api.ts'
import { readJarEntries } from '../jar-icon.ts'

export interface ModFileInfo {
  fileName: string
  path: string
  modId: string | null
  name: string | null
  version: string | null
  depends: Record<string, string>
  mixins: string[]
  packages: string[]
  enabled: boolean
}

export interface DependencyIssue {
  modId: string
  name: string
  missing: string[]
}

const PLATFORM_IDS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge'])
const MOD_ALIASES: Record<string, string> = {
  'fabric-api': 'Fabric API',
  'cloth-config': 'Cloth Config',
  'architectury': 'Architectury API',
  'geckolib': 'GeckoLib',
  curios: 'Curios API',
  patchouli: 'Patchouli',
  trinkets: 'Trinkets'
}

export function modLabel(names: Map<string, string>, id: string): string {
  const name = names.get(id) ?? MOD_ALIASES[id.toLowerCase()]
  return name && name.toLowerCase() !== id.toLowerCase() ? `${name}（${id}）` : id
}
const META_ENTRIES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'mcmod.info']

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asDependencyMap(value: unknown): Record<string, string> {
  const raw = asRecord(value)
  const result: Record<string, string> = {}
  for (const [id, range] of Object.entries(raw)) {
    if (typeof range === 'string') result[id] = range
    else if (Array.isArray(range)) result[id] = range.filter((item) => typeof item === 'string').join(' || ')
  }
  return result
}

function entrypointValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry)
    else {
      const inner = asRecord(entry).value
      if (typeof inner === 'string') names.push(inner)
      else if (Array.isArray(inner)) names.push(...inner.filter((item): item is string => typeof item === 'string'))
    }
  }
  return names
}

export function packagesFromClasses(classes: string[]): string[] {
  return [
    ...new Set(
      classes
        .map((name) => name.split('.').slice(0, -1).join('.'))
        .filter((prefix) => prefix.includes('.') && prefix.length > 6)
    )
  ]
}

export function mixinConfigsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => mixinConfigsFrom(item))
  const config = asRecord(value).config
  return typeof config === 'string' ? [config] : []
}

export function parseFabricMeta(text: string): Partial<ModFileInfo> {
  const json = asRecord(JSON.parse(text))
  const entrypoints = asRecord(json.entrypoints)
  const classes = Object.values(entrypoints).flatMap((value) => entrypointValues(value))
  return {
    modId: typeof json.id === 'string' ? json.id : null,
    name: typeof json.name === 'string' ? json.name : null,
    version: typeof json.version === 'string' ? json.version : null,
    depends: asDependencyMap(json.depends),
    mixins: mixinConfigsFrom(json.mixins),
    packages: packagesFromClasses(classes)
  }
}

export function parseQuiltMeta(text: string): Partial<ModFileInfo> {
  const json = asRecord(JSON.parse(text))
  const loader = asRecord(json.quilt_loader)
  const metadata = asRecord(loader.metadata)
  const entrypoints = asRecord(loader.entrypoints)
  const classes = Object.values(entrypoints).flatMap((value) => entrypointValues(value))
  return {
    modId: typeof loader.id === 'string' ? loader.id : null,
    name: typeof metadata.name === 'string' ? metadata.name : null,
    version: typeof loader.version === 'string' ? loader.version : null,
    depends: asDependencyMap(loader.depends),
    mixins: mixinConfigsFrom(loader.mixin ?? json.mixin),
    packages: packagesFromClasses(classes)
  }
}

function tomlSections(text: string): Array<{ header: string; body: string }> {
  const sections: Array<{ header: string; body: string }> = []
  let header = ''
  let body: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[\[?([^\]\n]+)\]\]?\s*$/.exec(line)
    if (match) {
      sections.push({ header, body: body.join('\n') })
      header = match[1].trim()
      body = []
    } else body.push(line)
  }
  sections.push({ header, body: body.join('\n') })
  return sections
}

export function parseModsToml(text: string): Partial<ModFileInfo> {
  const modId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null
  const displayName = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null
  const version = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null
  const depends: Record<string, string> = {}
  for (const section of tomlSections(text)) {
    if (!section.header.startsWith('dependencies')) continue
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(section.body)?.[1]
    const mandatory = /^\s*mandatory\s*=\s*(true|false)/m.exec(section.body)?.[1]
    if (id && mandatory !== 'false') depends[id] = /^\s*versionRange\s*=\s*["']([^"']*)["']/m.exec(section.body)?.[1] ?? '*'
  }
  return { modId, name: displayName, version, depends, mixins: [], packages: [] }
}

export function parseMcmodInfo(text: string): Partial<ModFileInfo> {
  const parsed = JSON.parse(text) as unknown
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed).modList
  const first = Array.isArray(list) ? asRecord(list[0]) : {}
  return {
    modId: typeof first.modid === 'string' ? first.modid : null,
    name: typeof first.name === 'string' ? first.name : null,
    version: typeof first.version === 'string' ? first.version : null,
    depends: {},
    mixins: [],
    packages: []
  }
}

function knownMeta(): Array<{ entry: string; parse(text: string): Partial<ModFileInfo> }> {
  return [
    { entry: 'fabric.mod.json', parse: parseFabricMeta },
    { entry: 'quilt.mod.json', parse: parseQuiltMeta },
    { entry: 'META-INF/neoforge.mods.toml', parse: parseModsToml },
    { entry: 'META-INF/mods.toml', parse: parseModsToml },
    { entry: 'mcmod.info', parse: parseMcmodInfo }
  ]
}

async function readModFile(path: string, fileName: string, enabled: boolean): Promise<ModFileInfo> {
  const info: ModFileInfo = { fileName, path, modId: null, name: null, version: null, depends: {}, mixins: [], packages: [], enabled }
  let entries: Map<string, Buffer>
  try {
    entries = await readJarEntries(path, META_ENTRIES)
  } catch {
    return info
  }
  for (const reader of knownMeta()) {
    const buffer = entries.get(reader.entry)
    if (!buffer) continue
    try {
      Object.assign(info, reader.parse(buffer.toString('utf8')))
    } catch {
    }
    break
  }
  return info
}

export async function scanMods(modsDir: string): Promise<ModFileInfo[]> {
  let names: string[]
  try {
    names = (await readdir(modsDir)).filter((name) => /\.jar(\.disabled)?$/i.test(name))
  } catch {
    return []
  }
  const list = await Promise.all(names.map((name) => readModFile(join(modsDir, name), name, !name.toLowerCase().endsWith('.disabled'))))
  return list.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'))
}

export function modNames(mods: ModFileInfo[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const mod of mods) if (mod.modId && mod.name) names.set(mod.modId, mod.name)
  return names
}

export function missingDependencies(mods: ModFileInfo[]): DependencyIssue[] {
  const provided = new Set(mods.filter((mod) => mod.enabled).map((mod) => mod.modId).filter((id): id is string => !!id))
  for (const id of PLATFORM_IDS) provided.add(id)
  const issues: DependencyIssue[] = []
  for (const mod of mods) {
    if (!mod.enabled || !mod.modId) continue
    const missing = Object.keys(mod.depends).filter((id) => !provided.has(id) && !PLATFORM_IDS.has(id))
    if (missing.length > 0) issues.push({ modId: mod.modId, name: mod.name ?? mod.fileName, missing })
  }
  return issues
}

export function duplicateModIds(mods: ModFileInfo[]): Array<{ modId: string; files: string[] }> {
  const byId = new Map<string, string[]>()
  for (const mod of mods) {
    if (!mod.enabled || !mod.modId || PLATFORM_IDS.has(mod.modId)) continue
    byId.set(mod.modId, [...(byId.get(mod.modId) ?? []), mod.fileName])
  }
  return [...byId.entries()].filter((entry) => entry[1].length > 1).map(([modId, files]) => ({ modId, files }))
}

export function loaderTag(loader: LoaderKind): string[] {
  if (loader === 'fabric') return ['fabric']
  if (loader === 'quilt') return ['quilt', 'fabric']
  if (loader === 'forge') return ['forge']
  if (loader === 'neoforge') return ['neoforge']
  return []
}

export function modDisplayName(mod: ModFileInfo): string {
  return mod.name ?? mod.modId ?? basename(mod.fileName, '.jar')
}
