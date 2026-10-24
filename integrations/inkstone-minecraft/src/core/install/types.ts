import type { DownloadSource, TaskProgress } from '../../shared/api.ts'
import type { SourceStats } from '../download/sources.ts'

export type ProgressListener = (progress: TaskProgress, detail?: string) => void

export interface InstallOptions {
  folder: string
  signal?: AbortSignal
  onProgress?: ProgressListener
  source?: DownloadSource
  concurrency?: number
  fetchImpl?: typeof fetch
  mirrorOrigin?: string
  stats?: SourceStats
  installerJavaPaths?: string[]
}

export interface InstallFile {
  url: string
  dest: string
  sha1: string | null
  size: number | null
}

export interface VersionInstallOptions extends InstallOptions {
  version: string
  name?: string
  isolated?: boolean
}

export interface LoaderInstallOptions extends VersionInstallOptions {
  loader?: string
  companions?: boolean
}

export interface InstallResult {
  name: string
  minecraft: string
  loader: 'vanilla' | 'fabric' | 'quilt'
  loaderVersion: string | null
  isolated: boolean
  total: number
  downloaded: number
  skipped: number
  bytes: number
  mods: string[]
  note: string | null
}

export interface CheckReport {
  name: string
  total: number
  missing: number
  files: string[]
}

export interface RepairResult extends CheckReport {
  repaired: number
  bytes: number
}

export type { LoaderVersion, LoaderVersions, MinecraftVersionEntry, MinecraftVersionList } from '../../shared/api.ts'

export type { DownloadSource, TaskProgress }
