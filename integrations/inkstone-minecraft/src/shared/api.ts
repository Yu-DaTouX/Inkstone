import type { CrashActionRequest, CrashActionResult, CrashDiagnosis, CrashExportResult, CrashRecordSummary } from './crash-api.ts'
import type { ContentCategory, ContentInstallRequest, ContentSearchQuery, ModpackInstallRequest, ModpackSummary } from './download-api.ts'
import type { LaunchEffective, LaunchStep, PreflightReport, PreflightRequest } from './launch-api.ts'
import type { CopyInstanceResult, InstanceIconOption, InstanceTrashRecord, ResourceKind, ScreenshotEntry, VersionResources } from './version-api.ts'
import type { InstanceOverride, InstanceOverview, ModBatchResult, ModInstallRequest, ModListResult, ModrinthProject, ModrinthSearchQuery, ModrinthSearchResult, ModrinthVersion, ModUpdateCheckResult, ModUpdateRequest } from './mods-api.ts'

export type LoaderKind = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'unknown'

export interface GameFolder {
  name: string
  path: string
}

export interface InstanceInfo {
  id: string
  folder: string
  minecraftVersion: string | null
  loader: LoaderKind
  loaderVersion: string | null
  javaMajor: number | null
  isolated: boolean
  gameDir: string
  modCount: number
  preferredJava: string | null
  error: string | null
}

export interface JavaEntry {
  path: string
  version: string
  majorVersion: number
}

export interface MinecraftVersionEntry {
  id: string
  type: string
  group: 'release' | 'snapshot' | 'old'
  url: string
  sha1: string | null
  size: number | null
  releaseTime: string | null
  latest: boolean
}

export interface MinecraftVersionList {
  latest: { release: string | null; snapshot: string | null }
  versions: MinecraftVersionEntry[]
}

export interface LoaderVersion {
  version: string
  stable: boolean
}

export interface LoaderVersions {
  minecraft: string
  loaders: LoaderVersion[]
  recommended: string | null
  reason: string | null
}

export type InstallKind = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'

export interface InstallRequest {
  folder: string
  kind: InstallKind
  minecraft: string
  loader?: string
  name?: string
  companions?: boolean
}

export type PclAccountType = 'microsoft' | 'authlib' | 'offline' | 'unknown'

export interface PclAccountRef {
  type: PclAccountType
  username: string
  uuid: string
  server: string | null
  serverName: string | null
}

export interface PclSnapshot {
  found: boolean
  sources: string[]
  folders: GameFolder[]
  selectedFolder: string | null
  selectedVersion: string | null
  javaPaths: string[]
  accounts: PclAccountRef[]
  downloadFolder: string | null
}

export type AccountKind = 'offline' | 'microsoft' | 'yggdrasil'

export interface Account {
  id: string
  kind: AccountKind
  name: string
  uuid: string
  server: string | null
  serverName: string | null
  source: 'local' | 'pcl'
  signedIn: boolean
}

export interface SkinInfo {
  dataUrl: string | null
  slim: boolean
}

export type DownloadSource = 'auto' | 'official' | 'bmclapi'
export type ThemePreference = 'system' | 'light' | 'dark'

export interface DownloadProbe {
  source: 'official' | 'bmclapi'
  label: string
  ms: number | null
  bytes: number
  error: string | null
}

export interface LauncherSettings {
  folders: GameFolder[]
  selectedFolder: string | null
  selectedVersion: string | null
  accounts: Account[]
  selectedAccountId: string | null
  maxMemoryMb: number
  extraJavaPaths: string[]
  importedFromPclAt: number | null
  downloadSource: DownloadSource
  downloadConcurrency: number
  theme: ThemePreference
}

export type TaskKind = 'install' | 'repair' | 'mod-install' | 'mod-update' | 'export'
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TaskProgress {
  done: number
  total: number
  unit: 'files' | 'bytes' | 'steps'
}

export interface TaskInfo {
  id: string
  kind: TaskKind
  title: string
  target: string | null
  state: TaskState
  progress: TaskProgress | null
  detail: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
}

export type FolderTarget = 'version' | 'game' | 'mods' | 'saves' | 'resourcepacks' | 'shaderpacks' | 'screenshots' | 'logs' | 'crash-reports'

export interface LaunchRequest {
  folder: string
  versionId: string
  accountId?: string
  username?: string
  javaPath?: string
  gameDir?: string
  maxMemoryMb?: number
  ignoreWarnings?: boolean
}

export type LaunchState = 'idle' | 'starting' | 'running' | 'exited' | 'failed'

export interface LaunchStatus {
  state: LaunchState
  versionId: string | null
  pid: number | null
  exitCode: number | null
  error: string | null
  crashReport: string | null
  javaPath: string | null
  steps?: LaunchStep[]
  effective?: LaunchEffective | null
  runningSince?: number | null
  crashId?: string | null
}

export interface LogLine {
  at: number
  stream: 'out' | 'err' | 'launcher'
  text: string
}

export interface CraftApi {
  settings(): Promise<LauncherSettings>
  updateSettings(patch: Partial<LauncherSettings>): Promise<LauncherSettings>
  instances(folder: string): Promise<InstanceInfo[]>
  minecraftVersions(): Promise<MinecraftVersionList>
  loaderVersions(kind: InstallKind, minecraft: string): Promise<LoaderVersions>
  install(request: InstallRequest): Promise<string>
  repair(folder: string, versionId: string): Promise<string>
  onInstancesChanged(listener: (folder: string) => void): () => void
  javas(): Promise<JavaEntry[]>
  pickJava(): Promise<string | null>
  probeDownloadSources(): Promise<DownloadProbe[]>
  pclSnapshot(): Promise<PclSnapshot>
  importPcl(): Promise<LauncherSettings>
  addOfflineAccount(name: string): Promise<LauncherSettings>
  removeAccount(id: string): Promise<LauncherSettings>
  selectAccount(id: string): Promise<LauncherSettings>
  skin(accountId: string): Promise<SkinInfo>
  instanceIcon(folder: string, versionId: string): Promise<string | null>
  openFolder(folder: string, versionId: string, target: FolderTarget): Promise<string | null>
  tasks(): Promise<TaskInfo[]>
  cancelTask(id: string): Promise<void>
  clearFinishedTasks(): Promise<void>
  onTask(listener: (task: TaskInfo) => void): () => void
  pickFolder(): Promise<string | null>
  launch(request: LaunchRequest): Promise<LaunchStatus>
  stop(): Promise<LaunchStatus>
  status(): Promise<LaunchStatus>
  logs(): Promise<LogLine[]>
  onLog(listener: (line: LogLine) => void): () => void
  onStatus(listener: (status: LaunchStatus) => void): () => void
  preflight(request: PreflightRequest): Promise<PreflightReport>
  launchJava(folder: string, versionId: string, javaPath: string | null): Promise<void>
  crashLatest(folder: string, versionId: string): Promise<CrashDiagnosis | null>
  crashList(folder: string, versionId: string): Promise<CrashRecordSummary[]>
  crashExport(folder: string, versionId: string, id: string): Promise<CrashExportResult | null>
  crashAction(request: CrashActionRequest): Promise<CrashActionResult>
  onCrash(listener: (diagnosis: CrashDiagnosis) => void): () => void
  instanceOverview(folder: string, versionId: string): Promise<InstanceOverview>
  updateInstanceSettings(folder: string, versionId: string, patch: Partial<InstanceOverride>): Promise<InstanceOverride>
  modList(folder: string, versionId: string): Promise<ModListResult>
  modToggle(folder: string, versionId: string, file: string, enabled: boolean): Promise<ModListResult>
  modRemove(folder: string, versionId: string, file: string): Promise<ModListResult>
  modRestore(folder: string, versionId: string, id: string): Promise<ModListResult>
  modCheckUpdates(folder: string, versionId: string): Promise<ModUpdateCheckResult>
  modUpdate(request: ModUpdateRequest): Promise<string>
  modInstall(request: ModInstallRequest): Promise<string>
  modAddFiles(folder: string, versionId: string, paths: string[]): Promise<string[]>
  modToggleMany(folder: string, versionId: string, files: string[], enabled: boolean): Promise<ModBatchResult>
  modRemoveMany(folder: string, versionId: string, files: string[]): Promise<ModBatchResult>
  modInstallDeps(folder: string, versionId: string, modIds: string[]): Promise<string>
  pathForFile(file: File): string
  pickModFiles(): Promise<string[]>
  modSearch(query: ModrinthSearchQuery): Promise<ModrinthSearchResult>
  modVersions(projectId: string, loader: string | null, minecraft: string | null): Promise<ModrinthVersion[]>
  modProject(projectId: string): Promise<ModrinthProject | null>
  downloadCategories(projectType: string): Promise<ContentCategory[]>
  downloadSearch(query: ContentSearchQuery): Promise<ModrinthSearchResult>
  downloadVersions(projectId: string, loader: string | null, minecraft: string | null): Promise<ModrinthVersion[]>
  downloadInstall(request: ContentInstallRequest): Promise<string>
  pickModpack(): Promise<string | null>
  inspectModpack(path: string): Promise<ModpackSummary>
  importModpack(request: ModpackInstallRequest): Promise<string>
  openUrl(url: string): Promise<void>
  renameInstance(folder: string, versionId: string, nextId: string): Promise<{ id: string; jarRenamed: boolean }>
  copyInstance(folder: string, versionId: string, name: string | null): Promise<CopyInstanceResult>
  deleteInstance(folder: string, versionId: string): Promise<InstanceTrashRecord>
  trashedInstances(folder: string): Promise<InstanceTrashRecord[]>
  restoreInstance(folder: string, trashId: string): Promise<string>
  versionResources(folder: string, versionId: string): Promise<VersionResources>
  versionScreenshots(folder: string, versionId: string): Promise<ScreenshotEntry[]>
  resourceToggle(folder: string, versionId: string, file: string, enabled: boolean): Promise<VersionResources>
  resourceDelete(folder: string, versionId: string, kind: ResourceKind, file: string): Promise<VersionResources>
  instanceIconOptions(folder: string, versionId: string): Promise<InstanceIconOption[]>
  setInstanceIcon(folder: string, versionId: string, kind: string, ref: string | null): Promise<string | null>
  clearInstanceIcon(folder: string, versionId: string): Promise<void>
  pickImage(): Promise<string | null>
  crashGet(folder: string, versionId: string, id: string): Promise<CrashDiagnosis | null>
}
