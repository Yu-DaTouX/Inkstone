import type { ModEntry, ModIssue } from '../../shared/mods-api.ts'
import { matchesVersionRange } from './mc-range.ts'

export interface AnalyzeContext {
  loader: string
  minecraftVersion: string | null
}

const CONNECTOR_IDS = new Set(['connector', 'sinytraconnector', 'connectormod', 'connectivity', 'forgedfabric'])
const PLATFORM_IDS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'fabric_loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge', 'modloader', 'javafml', 'lowcodefml'])
const FABRIC_FAMILY = new Set(['fabric', 'quilt'])
const FORGE_FAMILY = new Set(['forge', 'neoforge', 'legacy'])

export function identifiersOf(mod: ModEntry): string[] {
  const ids = [mod.modId, ...mod.provides, ...mod.nestedIds].filter((id): id is string => !!id)
  return [...new Set(ids.map((id) => id.toLowerCase()))]
}

export function loaderMismatch(kind: string | null, loader: string, connector: boolean): boolean {
  if (!kind || connector) return false
  if (loader === 'forge' || loader === 'neoforge') return FABRIC_FAMILY.has(kind)
  if (loader === 'quilt') return FORGE_FAMILY.has(kind)
  if (loader === 'fabric') return FORGE_FAMILY.has(kind)
  return false
}

export function analyzeMods(mods: ModEntry[], context: AnalyzeContext): ModEntry[] {
  const active = new Map<string, ModEntry[]>()
  const disabledProvides = new Set<string>()
  const allProvides = new Set<string>()
  for (const mod of mods) {
    const ids = identifiersOf(mod)
    for (const id of ids) {
      allProvides.add(id)
      if (!mod.enabled) disabledProvides.add(id)
      const list = active.get(id) ?? []
      list.push(mod)
      active.set(id, list)
    }
  }
  const connector = [...active.keys()].some((id) => CONNECTOR_IDS.has(id))
  const modIdCounts = new Map<string, number>()
  for (const mod of mods) {
    const id = mod.modId?.toLowerCase()
    if (!id) continue
    modIdCounts.set(id, (modIdCounts.get(id) ?? 0) + 1)
  }

  for (const mod of mods) {
    const issues: ModIssue[] = []
    if (!mod.kind) {
      issues.push({ kind: 'no-metadata', text: '读不到 Mod 元数据，可能不是 Mod 文件', modId: null })
    }
    for (const dep of mod.dependencies) {
      const depId = dep.modId.toLowerCase()
      if (PLATFORM_IDS.has(depId)) continue
      const providers = active.get(depId) ?? []
      const usable = providers.filter((item) => item.enabled)
      if (dep.kind === 'breaks') {
        if (allProvides.has(depId)) issues.push({ kind: 'incompatible', text: `与 ${dep.modId} 不兼容`, modId: dep.modId })
        continue
      }
      if (!dep.required || usable.length > 0) continue
      const text = disabledProvides.has(depId) ? `缺少前置 ${dep.modId}（已停用）` : `缺少前置 ${dep.modId}`
      issues.push({ kind: 'missing-dependency', text, modId: dep.modId })
    }
    if (mod.mcRange && context.minecraftVersion && !matchesVersionRange(mod.mcRange, context.minecraftVersion)) {
      issues.push({ kind: 'mc-mismatch', text: `要求 Minecraft ${mod.mcRange}，本版本是 ${context.minecraftVersion}`, modId: mod.modId })
    }
    if (context.loader === 'vanilla' && mod.kind) {
      issues.push({ kind: 'loader-mismatch', text: '原版不能加载 Mod', modId: mod.modId })
    } else if (loaderMismatch(mod.kind, context.loader, connector)) {
      issues.push({ kind: 'loader-mismatch', text: '加载器不匹配', modId: mod.modId })
    }
    if (mod.modId && (modIdCounts.get(mod.modId.toLowerCase()) ?? 0) > 1) {
      issues.push({ kind: 'duplicate', text: '重复安装', modId: mod.modId })
    }
    mod.issues = issues
  }
  return mods
}

export function countIssues(mods: ModEntry[]): number {
  return mods.filter((mod) => mod.issues.length > 0).length
}
