import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions } from './fabric-meta.ts'
import { gradleUserHome } from './gradle.ts'

export type Namespace = 'official' | 'intermediary' | 'yarn' | 'mojmap'
export const NAMESPACES: Namespace[] = ['official', 'intermediary', 'yarn', 'mojmap']

export interface MappedClass {
  names: Partial<Record<Namespace, string>>
}

export interface MappedMember {
  kind: 'field' | 'method'
  owner: MappedClass
  names: Partial<Record<Namespace, string>>
  descriptor: Partial<Record<Namespace, string>>
}

export interface MappingTable {
  minecraft: string
  sources: Partial<Record<Namespace, string>>
  classes: MappedClass[]
  members: MappedMember[]
}

interface TinyFile {
  namespaces: string[]
  classes: Array<{ names: string[]; members: Array<{ kind: 'field' | 'method'; desc: string; names: string[] }> }>
}

export function parseTiny(text: string): TinyFile {
  const lines = text.split(/\r?\n/)
  const header = lines[0].split('\t')
  if (header[0] !== 'tiny' || header[1] !== '2') throw new Error('只支持 tiny v2 映射')
  const namespaces = header.slice(3)
  const classes: TinyFile['classes'] = []
  let current: TinyFile['classes'][number] | null = null
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    if (line.startsWith('c\t')) {
      current = { names: line.split('\t').slice(1), members: [] }
      classes.push(current)
    } else if (current && (line.startsWith('\tf\t') || line.startsWith('\tm\t'))) {
      const parts = line.split('\t')
      current.members.push({ kind: parts[1] === 'f' ? 'field' : 'method', desc: parts[2], names: parts.slice(3) })
    }
  }
  return { namespaces, classes }
}

const PRIMITIVES: Record<string, string> = { void: 'V', boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' }

export function proguardTypeToDescriptor(type: string, mapClass: (name: string) => string): string {
  let base = type.trim()
  let dims = ''
  while (base.endsWith('[]')) {
    dims += '['
    base = base.slice(0, -2)
  }
  if (PRIMITIVES[base]) return dims + PRIMITIVES[base]
  return `${dims}L${mapClass(base.replaceAll('.', '/'))};`
}

export interface ProguardClass {
  named: string
  obf: string
  members: Array<{ kind: 'field' | 'method'; named: string; obf: string; type: string; params: string[] | null }>
}

export function parseProguard(text: string): ProguardClass[] {
  const classes: ProguardClass[] = []
  let current: ProguardClass | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue
    if (!raw.startsWith(' ')) {
      const match = raw.match(/^(\S+) -> (\S+):$/)
      if (!match) continue
      current = { named: match[1].replaceAll('.', '/'), obf: match[2].replaceAll('.', '/'), members: [] }
      classes.push(current)
      continue
    }
    if (!current) continue
    const line = raw.trim().replace(/^\d+:\d+:/, '')
    const method = line.match(/^(\S+) ([^\s(]+)\(([^)]*)\)(?::\d+:\d+)? -> (\S+)$/)
    if (method) {
      current.members.push({ kind: 'method', type: method[1], named: method[2], params: method[3] ? method[3].split(',') : [], obf: method[4] })
      continue
    }
    const field = line.match(/^(\S+) (\S+) -> (\S+)$/)
    if (field) current.members.push({ kind: 'field', type: field[1], named: field[2], params: null, obf: field[3] })
  }
  return classes
}

export function buildTable(minecraft: string, intermediary: TinyFile, named: TinyFile | null, mojmap: ProguardClass[] | null, sources: MappingTable['sources']): MappingTable {
  const officialIndex = intermediary.namespaces.indexOf('official')
  const interIndex = intermediary.namespaces.indexOf('intermediary')
  const classByOfficial = new Map<string, MappedClass>()
  const classByInter = new Map<string, MappedClass>()
  const memberByOfficial = new Map<string, MappedMember>()
  const memberByInter = new Map<string, MappedMember>()
  const classes: MappedClass[] = []
  const members: MappedMember[] = []
  for (const entry of intermediary.classes) {
    const mapped: MappedClass = { names: { official: entry.names[officialIndex], intermediary: entry.names[interIndex] } }
    classes.push(mapped)
    classByOfficial.set(entry.names[officialIndex], mapped)
    classByInter.set(entry.names[interIndex], mapped)
    for (const member of entry.members) {
      const item: MappedMember = { kind: member.kind, owner: mapped, names: { official: member.names[officialIndex], intermediary: member.names[interIndex] }, descriptor: { official: member.desc } }
      members.push(item)
      memberByOfficial.set(`${entry.names[officialIndex]}.${member.names[officialIndex]}${member.kind === 'method' ? member.desc : ''}`, item)
      memberByInter.set(`${member.kind}:${member.names[interIndex]}`, item)
    }
  }
  if (named) {
    const fromIndex = named.namespaces.indexOf('intermediary')
    const toIndex = named.namespaces.indexOf('named')
    if (fromIndex >= 0 && toIndex >= 0) {
      for (const entry of named.classes) {
        const owner = classByInter.get(entry.names[fromIndex])
        if (owner) owner.names.yarn = entry.names[toIndex]
        for (const member of entry.members) {
          const target = memberByInter.get(`${member.kind}:${member.names[fromIndex]}`)
          if (target) {
            target.names.yarn = member.names[toIndex]
            target.descriptor.intermediary ??= member.desc
          }
        }
      }
    }
  }
  if (mojmap) {
    const officialOf = new Map(mojmap.map((entry) => [entry.named, entry.obf]))
    const mapClass = (name: string) => officialOf.get(name) ?? name
    for (const entry of mojmap) {
      const owner = classByOfficial.get(entry.obf)
      if (owner) owner.names.mojmap = entry.named
      for (const member of entry.members) {
        const desc = member.kind === 'method' ? `(${(member.params ?? []).map((param) => proguardTypeToDescriptor(param, mapClass)).join('')})${proguardTypeToDescriptor(member.type, mapClass)}` : ''
        const target = memberByOfficial.get(`${entry.obf}.${member.obf}${desc}`)
        if (target) target.names.mojmap = member.named
      }
    }
  }
  return { minecraft, sources, classes, members }
}

function simpleName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).replace(/^.*\$/, '')
}

function classMatches(mapped: MappedClass, query: string): boolean {
  const normalized = query.replaceAll('.', '/')
  return NAMESPACES.some((ns) => {
    const name = mapped.names[ns]
    if (!name) return false
    if (name === normalized) return true
    if (normalized.includes('/')) return name.endsWith(`/${normalized}`) || name.endsWith(`$${normalized}`)
    return simpleName(name) === normalized || name.slice(name.lastIndexOf('/') + 1) === normalized
  })
}

export function lookupMapping(table: MappingTable, query: string, limit = 20): { classes: MappedClass[]; members: MappedMember[] } {
  const trimmed = query.trim()
  const hash = trimmed.indexOf('#')
  if (hash >= 0) {
    const owner = trimmed.slice(0, hash)
    const member = trimmed.slice(hash + 1)
    return { classes: [], members: table.members.filter((item) => classMatches(item.owner, owner) && NAMESPACES.some((ns) => item.names[ns] === member)).slice(0, limit) }
  }
  const classes = table.classes.filter((mapped) => classMatches(mapped, trimmed)).slice(0, limit)
  const members = trimmed.includes('/') || trimmed.includes('.') ? [] : table.members.filter((item) => NAMESPACES.some((ns) => item.names[ns] === trimmed)).slice(0, limit)
  return { classes, members }
}

export function formatMapping(result: { classes: MappedClass[]; members: MappedMember[] }, table: MappingTable): string {
  const available = NAMESPACES.filter((ns) => ns === 'official' || ns === 'intermediary' || table.sources[ns])
  const lines: string[] = []
  for (const mapped of result.classes) {
    lines.push('类：')
    for (const ns of available) lines.push(`  ${ns.padEnd(12)} ${mapped.names[ns] ?? '—'}`)
  }
  for (const member of result.members) {
    lines.push(`${member.kind === 'method' ? '方法' : '字段'}（所属类 ${member.owner.names.yarn ?? member.owner.names.mojmap ?? member.owner.names.intermediary}）：`)
    for (const ns of available) lines.push(`  ${ns.padEnd(12)} ${member.owner.names[ns] ?? '?'}#${member.names[ns] ?? '—'}`)
    if (member.descriptor.intermediary) lines.push(`  描述符（intermediary） ${member.descriptor.intermediary}`)
  }
  if (!lines.length) lines.push('没有找到匹配的名字')
  const missing = NAMESPACES.filter((ns) => !available.includes(ns))
  if (missing.length) lines.push(`（缺少 ${missing.join('、')} 映射）`)
  return lines.join('\n')
}

export async function loomMinecraftDir(minecraft: string, userHome = gradleUserHome()): Promise<string> {
  return join(userHome, 'caches', 'fabric-loom', minecraft)
}

export async function findYarnTiny(minecraft: string, userHome = gradleUserHome()): Promise<string | null> {
  const dir = await loomMinecraftDir(minecraft, userHome)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const yarn = names.filter((name) => name.startsWith('net.fabricmc.yarn.')).sort(compareVersions).at(-1)
  const file = yarn ? join(dir, yarn, 'mappings.tiny') : null
  return file && existsSync(file) ? file : null
}

export async function ensureMojmap(minecraft: string, cacheDir: string, userHome = gradleUserHome(), download = true): Promise<string | null> {
  const target = join(cacheDir, `${minecraft}-client.txt`)
  if (existsSync(target)) return target
  const info = JSON.parse(await readFile(join(await loomMinecraftDir(minecraft, userHome), 'mojang_minecraft_info.json'), 'utf8').catch(() => '{}')) as { downloads?: { client_mappings?: { url?: string; sha1?: string } } }
  const meta = info.downloads?.client_mappings
  if (!download || !meta?.url) return null
  const response = await fetch(meta.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 Mojang 映射失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (meta.sha1 && createHash('sha1').update(bytes).digest('hex') !== meta.sha1) throw new Error('Mojang 映射校验失败')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(target, bytes)
  return target
}

const tables = new Map<string, Promise<MappingTable>>()

export function loadMappingTable(minecraft: string, cacheDir: string, options: { mojmap?: boolean; userHome?: string } = {}): Promise<MappingTable> {
  const key = `${minecraft}|${options.mojmap !== false}`
  let table = tables.get(key)
  if (!table) {
    table = (async () => {
      const dir = await loomMinecraftDir(minecraft, options.userHome)
      const interFile = join(dir, 'intermediary-v2.tiny')
      if (!existsSync(interFile)) throw new Error(`没有 Minecraft ${minecraft} 的 intermediary 映射，先在项目里构建一次`)
      const yarnFile = await findYarnTiny(minecraft, options.userHome)
      const mojFile = options.mojmap === false ? null : await ensureMojmap(minecraft, cacheDir, options.userHome).catch(() => null)
      return buildTable(
        minecraft,
        parseTiny(await readFile(interFile, 'utf8')),
        yarnFile ? parseTiny(await readFile(yarnFile, 'utf8')) : null,
        mojFile ? parseProguard(await readFile(mojFile, 'utf8')) : null,
        { official: interFile, intermediary: interFile, ...(yarnFile ? { yarn: yarnFile } : {}), ...(mojFile ? { mojmap: mojFile } : {}) }
      )
    })()
    table.catch(() => tables.delete(key))
    tables.set(key, table)
  }
  return table
}
