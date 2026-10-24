export type ModMetaKind = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'legacy'

export type ModIssueKind = 'missing-dependency' | 'incompatible' | 'mc-mismatch' | 'loader-mismatch' | 'duplicate' | 'no-metadata' | 'update'

export interface ModIssue {
  kind: ModIssueKind
  text: string
  modId: string | null
}

export interface ModDependencyRef {
  modId: string
  required: boolean
  versionRange: string | null
  kind: 'depends' | 'breaks'
}

export interface ModEntry {
  file: string
  enabled: boolean
  size: number
  sha1: string
  modifiedAt: number
  kind: ModMetaKind | null
  modId: string | null
  name: string
  version: string | null
  description: string | null
  icon: string | null
  remoteIconUrl: string | null
  projectId: string | null
  mcRange: string | null
  dependencies: ModDependencyRef[]
  provides: string[]
  nestedIds: string[]
  issues: ModIssue[]
}

export interface ModCounts {
  total: number
  enabled: number
  disabled: number
  updates: number
  issues: number
}

export interface ModListResult {
  versionId: string
  gameDir: string
  loader: string
  minecraftVersion: string | null
  mods: ModEntry[]
  counts: ModCounts
  trash: ModTrashEntry[]
}

export interface ModTrashEntry {
  id: string
  name: string
  file: string
  size: number
  deletedAt: number
  versionId: string
}

export interface ModUpdateInfo {
  sha1: string
  file: string
  projectId: string
  projectTitle: string | null
  versionId: string
  versionNumber: string
  fileName: string
  fileSha1: string
  fileSize: number
  downloadUrl: string
  iconUrl: string | null
  gameVersions: string[]
  loaders: string[]
}

export interface ModUpdateCheckResult {
  checkedAt: number
  updates: ModUpdateInfo[]
  unknown: string[]
  error: string | null
}

export interface ModrinthHit {
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  follows: number
  updated: string
  categories: string[]
  iconUrl: string | null
}

export interface ModrinthSearchResult {
  hits: ModrinthHit[]
  totalHits: number
  offset: number
  limit: number
}

export type ModrinthSort = 'relevance' | 'downloads' | 'updated' | 'newest'

export interface ModrinthSearchQuery {
  query: string
  loader: string | null
  minecraft: string | null
  sort: ModrinthSort
  limit: number
  offset: number
}

export interface ModrinthVersionFile {
  url: string
  fileName: string
  size: number
  sha1: string
}

export interface ModrinthDependency {
  projectId: string | null
  versionId: string | null
  fileName: string | null
  kind: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface ModrinthVersion {
  id: string
  projectId: string
  projectTitle: string | null
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  publishedAt: string
  downloads: number
  file: ModrinthVersionFile
  dependencies: ModrinthDependency[]
  existsLocally: boolean
}

export interface ModrinthProject {
  projectId: string
  slug: string
  title: string
  description: string
  body: string
  categories: string[]
  downloads: number
  iconUrl: string | null
  sourceUrl: string | null
  issuesUrl: string | null
}

export interface ModBatchResult {
  list: ModListResult
  done: string[]
  failed: Array<{ file: string; reason: string }>
}

export interface ModInstallRequest {
  folder: string
  versionId: string
  versionFileId: string
}

export interface ModInstallResult {
  installed: string[]
  skipped: string[]
  dependencies: string[]
  targetDir: string
}

export interface ModUpdateRequest {
  folder: string
  versionId: string
  updates: ModUpdateInfo[]
}

export interface ModUpdateResult {
  updated: string[]
  skipped: string[]
  trashed: string[]
}

export interface InstanceOverride {
  javaPath: string | null
  maxMemoryMb: number | null
  jvmArgs: string | null
  gameArgs: string | null
  windowWidth: number | null
  windowHeight: number | null
  fullscreen: boolean | null
  server: string | null
  autoEnter: boolean | null
}

export interface InstanceOverrideView {
  folder: string
  versionId: string
  override: InstanceOverride
  effective: {
    javaPath: string | null
    maxMemoryMb: number
    jvmArgs: string
    gameArgs: string
    windowWidth: number | null
    windowHeight: number | null
    fullscreen: boolean
    server: string | null
  }
  source: {
    java: 'instance' | 'pcl' | 'global'
    memory: 'instance' | 'pcl' | 'global'
    window: 'instance' | 'global'
  }
  gameDir: string
  isolated: boolean
  sizeBytes: number
  lastPlayedAt: number | null
}

export interface InstanceOverview extends InstanceOverrideView {
  modCount: number
  minecraftVersion: string | null
  loader: string
  loaderVersion: string | null
  javaMajor: number | null
  error: string | null
  problems: Array<{ kind: 'json' | 'deps' | 'java' | 'files'; text: string }>
}
