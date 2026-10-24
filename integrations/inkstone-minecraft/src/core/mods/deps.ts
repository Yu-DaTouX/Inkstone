import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ModEntry, ModrinthVersion } from '../../shared/mods-api.ts'
import type { TaskProgress } from '../../shared/api.ts'
import { downloadFiles } from '../download/download.ts'
import { compareVersions, matchesVersionRange } from './mc-range.ts'
import type { ModrinthClient } from './modrinth.ts'

const PLATFORM_IDS = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'fabric_loader',
  'quilt_loader',
  'quilt-loader',
  'forge',
  'neoforge',
  'modloader',
  'javafml',
  'lowcodefml'
])

export interface DependencyNeed {
  modId: string
  ranges: string[]
  requiredBy: string[]
}

export interface DependencyPick {
  need: DependencyNeed
  version: ModrinthVersion | null
  reason: string | null
}

export interface DependencyInstallContext {
  modsDir: string
  loader: string
  minecraftVersion: string | null
}

export interface DependencyInstallOptions {
  client: ModrinthClient
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?(progress: TaskProgress, detail?: string): void
}

export interface DependencyInstallOutcome {
  installed: string[]
  skipped: string[]
  failed: Array<{ modId: string; reason: string }>
  picks: DependencyPick[]
}

export function normaliseRange(range: string | null | undefined): string | null {
  const text = String(range ?? '').trim()
  if (!text || text === '*' || text === 'any' || text === 'x') return null
  return text
}

export function collectDependencyNeeds(mods: ModEntry[], modIds: string[]): DependencyNeed[] {
  const wanted = new Set(modIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0 && !PLATFORM_IDS.has(id)))
  const needs = new Map<string, DependencyNeed>()
  const ensure = (modId: string): DependencyNeed => {
    const existing = needs.get(modId)
    if (existing) return existing
    const created: DependencyNeed = { modId, ranges: [], requiredBy: [] }
    needs.set(modId, created)
    return created
  }
  for (const id of wanted) ensure(id)
  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      const id = dep.modId.toLowerCase()
      if (!wanted.has(id) || !dep.required || dep.kind === 'breaks') continue
      const need = ensure(id)
      const range = normaliseRange(dep.versionRange)
      if (range && !need.ranges.includes(range)) need.ranges.push(range)
      if (!need.requiredBy.includes(mod.name)) need.requiredBy.push(mod.name)
    }
  }
  return [...needs.values()]
}

export function missingDependencyIds(mods: ModEntry[]): string[] {
  const ids = new Set<string>()
  for (const mod of mods) {
    for (const issue of mod.issues) {
      if (issue.kind !== 'missing-dependency') continue
      const id = (issue.modId ?? '').trim().toLowerCase()
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function dependencyVersionLabel(version: ModrinthVersion): string {
  const raw = version.versionNumber.trim()
  const match = /^(?:mc)?(\d+\.\d+(?:\.\d+)?)-(.+)$/i.exec(raw)
  if (!match) return raw
  const [, prefix, rest] = match
  if (!prefix || !rest) return raw
  if (!version.gameVersions.some((game) => game === prefix || game.startsWith(`${prefix}.`))) return raw
  return rest
}

function numericVersion(label: string): string {
  const match = /^\d+(?:\.\d+)*/.exec(label)
  return match ? match[0] : label
}

function rangeMatches(range: string, label: string): boolean {
  if (matchesVersionRange(range, label)) return true
  const numeric = numericVersion(label)
  return numeric !== label && matchesVersionRange(range, numeric)
}

export function pickVersionForRange(versions: ModrinthVersion[], range: string | null | undefined): { version: ModrinthVersion | null; reason: string | null } {
  const sorted = [...versions].sort(
    (a, b) => compareVersions(dependencyVersionLabel(b), dependencyVersionLabel(a)) || (b.publishedAt > a.publishedAt ? 1 : -1)
  )
  if (sorted.length === 0) return { version: null, reason: 'Modrinth 上没有适合本加载器和游戏版本的文件' }
  const wanted = normaliseRange(range)
  if (!wanted) return { version: sorted[0], reason: null }
  const hit = sorted.find((version) => rangeMatches(wanted, dependencyVersionLabel(version)))
  if (hit) return { version: hit, reason: null }
  return { version: null, reason: `需要 ${wanted}，Modrinth 上的 ${sorted.length} 个版本都不符合（最新 ${dependencyVersionLabel(sorted[0]!)}）` }
}

const FABRIC_FAMILY_LOADERS = ['quilt', 'fabric']

export function loaderTags(loader: string): string[] {
  return loader === 'quilt' ? [...FABRIC_FAMILY_LOADERS] : [loader]
}

export function spacedQueries(modId: string): string[] {
  const text = modId.trim()
  if (!/^[a-z0-9]+$/.test(text) || text.length < 6) return []
  const out: string[] = []
  for (let index = text.length - 1; index > 1; index -= 1) {
    const variant = `${text.slice(0, index)} ${text.slice(index)}`
    if (!out.includes(variant)) out.push(variant)
  }
  return out.slice(0, 8)
}

async function projectVersions(client: ModrinthClient, project: string, loader: string, minecraft: string | null): Promise<ModrinthVersion[]> {
  const found = new Map<string, ModrinthVersion>()
  for (const tag of loaderTags(loader)) {
    const list = await client.versions(project, { loader: tag, minecraft })
    for (const version of list) found.set(version.id, version)
  }
  return [...found.values()]
}

async function findProject(client: ModrinthClient, modId: string, loader: string, minecraft: string | null): Promise<string[]> {
  const queries = [modId, ...spacedQueries(modId)]
  for (const query of queries) {
    const search = await client.search({ query, loader, minecraft, sort: 'relevance', limit: 5, offset: 0 })
    const hit = search.hits.find((item) => item.slug.toLowerCase() === modId.toLowerCase()) ?? search.hits[0]
    if (hit) return [hit.projectId]
  }
  return []
}

async function versionsOf(client: ModrinthClient, need: DependencyNeed, context: DependencyInstallContext): Promise<ModrinthVersion[]> {
  const direct = await projectVersions(client, need.modId, context.loader, context.minecraftVersion)
  if (direct.length > 0) return direct
  for (const project of await findProject(client, need.modId, context.loader, context.minecraftVersion)) {
    const list = await projectVersions(client, project, context.loader, context.minecraftVersion)
    if (list.length > 0) return list
  }
  return []
}

export async function resolveDependencyNeeds(
  client: ModrinthClient,
  needs: DependencyNeed[],
  context: DependencyInstallContext,
  options: { signal?: AbortSignal; onProgress?(progress: TaskProgress, detail?: string): void } = {}
): Promise<DependencyPick[]> {
  const picks: DependencyPick[] = []
  let done = 0
  for (const need of needs) {
    options.onProgress?.({ done, total: needs.length, unit: 'steps' }, `查找 ${need.modId}`)
    if (options.signal?.aborted) throw new Error('已取消')
    try {
      const versions = await versionsOf(client, need, context)
      const range = need.ranges.find((item) => !!item) ?? null
      let chosen = pickVersionForRange(versions, range)
      if (!chosen.version && need.ranges.length > 1) {
        for (const candidate of need.ranges) {
          chosen = pickVersionForRange(versions, candidate)
          if (chosen.version) break
        }
      }
      picks.push({ need, version: chosen.version, reason: chosen.version ? null : (chosen.reason ?? '没有可用版本') })
    } catch (error) {
      picks.push({ need, version: null, reason: error instanceof Error ? error.message : String(error) })
    }
    done += 1
  }
  options.onProgress?.({ done, total: needs.length, unit: 'steps' }, '查找完成')
  return picks
}

export async function installDependencyNeeds(
  needs: DependencyNeed[],
  context: DependencyInstallContext,
  options: DependencyInstallOptions
): Promise<DependencyInstallOutcome> {
  const outcome: DependencyInstallOutcome = { installed: [], skipped: [], failed: [], picks: [] }
  if (needs.length === 0) return outcome
  const picks = await resolveDependencyNeeds(options.client, needs, context, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  outcome.picks = picks
  const downloads: Array<{ url: string; dest: string; sha1: string; size: number; modId: string }> = []
  for (const pick of picks) {
    if (!pick.version) {
      outcome.failed.push({ modId: pick.need.modId, reason: pick.reason ?? '没有可用版本' })
      continue
    }
    const dest = join(context.modsDir, pick.version.file.fileName)
    if (existsSync(dest)) {
      outcome.skipped.push(pick.version.file.fileName)
      continue
    }
    downloads.push({
      url: pick.version.file.url,
      dest,
      sha1: pick.version.file.sha1,
      size: pick.version.file.size,
      modId: pick.need.modId
    })
  }
  if (downloads.length > 0) {
    await downloadFiles(
      downloads.map((item) => ({ url: item.url, dest: item.dest, sha1: item.sha1, size: item.size })),
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? '下载依赖')
      }
    )
    for (const item of downloads) outcome.installed.push(item.dest.split(/[\\/]/).pop() ?? item.dest)
  }
  return outcome
}
