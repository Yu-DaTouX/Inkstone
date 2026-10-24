import type { ModrinthSort } from './mods-api.ts'

export type ContentProjectType = 'mod' | 'resourcepack' | 'shader' | 'modpack'

export type ContentInstallType = 'resourcepack' | 'shader'

export interface ContentCategory {
  name: string
  projectType: string
}

export interface ContentSearchQuery {
  projectType: ContentProjectType
  query: string
  category: string | null
  loader: string | null
  minecraft: string | null
  sort: ModrinthSort
  limit: number
  offset: number
}

export interface ContentInstallRequest {
  folder: string
  versionId: string
  projectType: ContentInstallType
  versionFileId: string
}

export interface ContentInstallResult {
  file: string
  dir: string
  skipped: boolean
}

export type ModpackLoader = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'

export interface ModpackSummary {
  path: string
  name: string | null
  versionId: string | null
  minecraft: string
  loader: ModpackLoader
  loaderVersion: string | null
  files: number
  clientFiles: number
  overrides: number
}

export interface ModpackInstallRequest {
  folder: string
  path: string
  name?: string
}

export interface ModpackInstallResult {
  name: string
  minecraft: string
  loader: ModpackLoader
  loaderVersion: string | null
  files: number
  downloaded: number
  skipped: number
  overrides: number
  bytes: number
}
