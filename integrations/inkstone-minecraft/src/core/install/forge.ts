import type { DownloadSource } from '../../shared/api.ts'
import type { SourceStats } from '../download/sources.ts'
import { installForgeLoader, type ForgeInstallResult } from './forge-install.ts'
import { forgeArtifactVersion, forgeCoordinate, forgeInstallerUrl, forgeLoaderVersion, forgeSupported, listForgeLoaders } from './forge-meta.ts'
import type { ProgressListener } from './types.ts'

export interface ForgeInstallOptions {
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
}

export type { ForgeInstallResult }

export { forgeArtifactVersion, forgeLoaderVersion, listForgeLoaders }

export async function installForge(options: ForgeInstallOptions): Promise<ForgeInstallResult> {
  if (!forgeSupported(options.minecraft)) throw new Error(`Forge 不支持 Minecraft ${options.minecraft}：1.5 及以下没有可用的安装器`)
  const download = {
    source: options.source,
    signal: options.signal,
    onProgress: options.onProgress,
    concurrency: options.concurrency,
    fetchImpl: options.fetchImpl,
    mirrorOrigin: options.mirrorOrigin,
    stats: options.stats
  }
  const listing = await listForgeLoaders(options.minecraft, download)
  const loader = options.loader ?? listing.recommended
  if (!loader) throw new Error(listing.reason ?? `${options.minecraft} 没有可用的 Forge 版本`)
  if (options.loader && !listing.loaders.some((entry) => entry.version === options.loader)) throw new Error(`${options.minecraft} 没有 Forge ${options.loader}`)
  const artifacts = listing.loaders.map((entry) => `${options.minecraft}-${entry.version}`)
  const artifact = forgeArtifactVersion(options.minecraft, loader, artifacts)
  const name = options.name ?? `${options.minecraft}-Forge ${loader}`
  return installForgeLoader({
    ...options,
    project: 'forge',
    version: loader,
    artifact,
    installerUrl: forgeInstallerUrl(artifact),
    coordinate: forgeCoordinate(artifact),
    name
  })
}
