import type { LoaderKind, TaskProgress } from '../../shared/api.ts'
import { installDependencyNeeds, type DependencyNeed } from '../mods/deps.ts'
import { ModrinthClient } from '../mods/modrinth.ts'

export interface DependencyInstallOptions {
  modsDir: string
  minecraftVersion: string | null
  loader: LoaderKind
  modIds: string[]
  ranges?: Record<string, string[]>
  requiredBy?: Record<string, string[]>
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
  fetchImpl?: typeof fetch
  client?: ModrinthClient
}

export interface DependencyInstallResult {
  installed: string[]
  failed: Array<{ modId: string; reason: string }>
}

export function needsOf(modIds: string[], ranges: Record<string, string[]> = {}, requiredBy: Record<string, string[]> = {}): DependencyNeed[] {
  return [...new Set(modIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0))].map((modId) => ({
    modId,
    ranges: ranges[modId] ?? [],
    requiredBy: requiredBy[modId] ?? []
  }))
}

export async function installMissingDependencies(options: DependencyInstallOptions): Promise<DependencyInstallResult> {
  const needs = needsOf(options.modIds, options.ranges, options.requiredBy)
  if (needs.length === 0) return { installed: [], failed: [] }
  const client =
    options.client ??
    new ModrinthClient({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })
  const outcome = await installDependencyNeeds(
    needs,
    { modsDir: options.modsDir, loader: options.loader, minecraftVersion: options.minecraftVersion },
    {
      client,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    }
  )
  options.onProgress?.({ done: needs.length, total: needs.length, unit: 'steps' }, '依赖处理完成')
  return { installed: [...outcome.installed, ...outcome.skipped], failed: outcome.failed }
}
