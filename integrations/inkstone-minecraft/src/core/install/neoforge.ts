import type { DownloadSource } from '../../shared/api.ts'
import type { SourceStats } from '../download/sources.ts'
import { installForgeLoader, type ForgeInstallResult } from './forge-install.ts'
import { listNeoForgeLoaders, neoForgeCoordinate, neoForgeInstallerUrl, neoForgeMinecraft, neoForgeProject } from './forge-meta.ts'
import type { ProgressListener } from './types.ts'

export interface NeoForgeInstallOptions {
  folder: string
  minecraft: string
  loader?: string
  name?: string
  isolated?: boolean
  javaPath?: string
  signal?: AbortSignal
  onProgress?: ProgressListener
  source?: DownloadSource
  concurrency?: number
  fetchImpl?: typeof fetch
  mirrorOrigin?: string
  stats?: SourceStats
  installerJavaPaths?: string[]
}

export type { ForgeInstallResult }

export { listNeoForgeLoaders, neoForgeMinecraft, neoForgeProject }

export async function installNeoForge(options: NeoForgeInstallOptions): Promise<ForgeInstallResult> {
  const download = {
    source: options.source,
    signal: options.signal,
    onProgress: options.onProgress,
    concurrency: options.concurrency,
    fetchImpl: options.fetchImpl,
    mirrorOrigin: options.mirrorOrigin,
    stats: options.stats
  }
  const listing = await listNeoForgeLoaders(options.minecraft, download)
  const version = options.loader ?? listing.recommended
  if (!version) throw new Error(listing.reason ?? `${options.minecraft} 没有可用的 NeoForge 版本`)
  if (!listing.loaders.some((entry) => entry.version === version)) throw new Error(`${options.minecraft} 没有 NeoForge ${version}`)
  const name = options.name ?? `${options.minecraft}-NeoForge ${version}`
  return installForgeLoader({
    ...options,
    project: 'neoforge',
    version,
    artifact: version,
    installerUrl: neoForgeInstallerUrl(version),
    coordinate: neoForgeCoordinate(version),
    name
  })
}
