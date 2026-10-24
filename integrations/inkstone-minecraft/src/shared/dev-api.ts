export type MappingFlavor = 'yarn' | 'mojmap'

export interface FabricVersionSet {
  minecraft: string
  loader: string
  yarn: string | null
  fabricApi: string
  loom: string
  loomPlugin: string
  gradle: string
  javaRelease: number
}

export interface CreateFabricProjectRequest {
  minecraftVersion: string
  modId: string
  packageName: string
  targetDir: string
  modName?: string
  mappings?: MappingFlavor
  versions?: Partial<FabricVersionSet>
  javaPath?: string
}

export interface CreateFabricProjectResult {
  projectDir: string
  versions: FabricVersionSet
  mappings: MappingFlavor
  files: string[]
  example: boolean
  javaPath: string | null
  wrapperSource: 'local-gradle' | 'download'
}

export interface JbrInfo {
  found: boolean
  path: string | null
  version: string | null
  majorVersion: number | null
  enhancedRedefinition: boolean
  downloadHint: string
}

export type DevRunState = 'idle' | 'building' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed'

export type CompanionOwner = 'agent' | 'user'

export interface CompanionControl {
  owner: CompanionOwner
  changedAt: number
  changedBy: CompanionOwner
}

export interface DevSessionInfo {
  projectDir: string
  pid: number | null
  state: DevRunState
  startedAt: number | null
  javaPath: string | null
  jbr: boolean
  enhancedRedefinition: boolean
  mixinHotswap: boolean
  minecraftVersion: string | null
  jdwpPort: number | null
  companionPort: number | null
  companionReady: boolean
  world: string | null
  logFile: string | null
  exitCode: number | null
  crashReport: string | null
  message: string | null
  control?: CompanionControl | null
}

export interface DevLaunchOptions {
  projectDir: string
  world?: string | null
  javaPath?: string
  maxMemoryMb?: number
  requireJbr?: boolean
  waitFor?: 'process' | 'companion' | 'world'
  timeoutMs?: number
}

export interface BuildResult {
  ok: boolean
  durationMs: number
  tasks: string[]
  output: string
  errors: string[]
}

export type RestartReason =
  | 'schema-change'
  | 'mixin'
  | 'metadata'
  | 'not-running'
  | 'jdwp-unavailable'
  | 'redefine-failed'

export interface HotswapResult {
  swapped: string[]
  added: string[]
  removed: string[]
  skippedNotLoaded: string[]
  restartNeeded: boolean
  restartReasons: Array<{ reason: RestartReason; detail: string }>
}

export interface ApplyResult {
  build: BuildResult
  hotswap: HotswapResult | null
  resourcesReloaded: boolean
  dataReloaded: boolean
  changedAssets: string[]
  changedData: string[]
  restartNeeded: boolean
  restarted: boolean
  notes: string[]
}

export interface CommandResult {
  command: string
  ok: boolean
  output: string[]
  error: string | null
}

export interface DevLogQuery {
  projectDir: string
  lines?: number
  filter?: string
  levels?: Array<'ERROR' | 'WARN' | 'INFO' | 'DEBUG'>
}

export interface CrashSummary {
  file: string
  at: number
  description: string | null
  exception: string | null
  suspectFrames: string[]
  head: string
}

export interface DevStatusSnapshot {
  session: DevSessionInfo
  jbr: JbrInfo
}

export interface DevApi {
  pickProject(): Promise<string | null>
  fabricVersions(minecraftVersion: string, mappings?: MappingFlavor): Promise<FabricVersionSet>
  createFabricProject(request: CreateFabricProjectRequest): Promise<CreateFabricProjectResult>
  jbr(minecraftVersion?: string): Promise<JbrInfo>
  status(projectDir: string): Promise<DevStatusSnapshot>
  launch(options: DevLaunchOptions): Promise<DevSessionInfo>
  stop(projectDir: string): Promise<DevSessionInfo>
  setControl(projectDir: string, owner: CompanionOwner): Promise<DevSessionInfo>
  restart(options: DevLaunchOptions): Promise<DevSessionInfo>
  build(projectDir: string): Promise<BuildResult>
  apply(projectDir: string, autoRestart?: boolean): Promise<ApplyResult>
  reloadResources(projectDir: string): Promise<ApplyResult>
  command(projectDir: string, command: string): Promise<CommandResult>
  screenshot(projectDir: string): Promise<string>
  render(projectDir: string, id: string, kind?: 'item' | 'block', size?: number): Promise<string>
  logs(query: DevLogQuery): Promise<string[]>
  crashes(projectDir: string): Promise<CrashSummary[]>
  onSession(listener: (session: DevSessionInfo) => void): () => void
  onLog(listener: (event: { projectDir: string; text: string }) => void): () => void
}

export const DEV_CHANNELS = {
  pickProject: 'craft-dev:pick-project',
  fabricVersions: 'craft-dev:fabric-versions',
  createFabricProject: 'craft-dev:create-fabric-project',
  jbr: 'craft-dev:jbr',
  status: 'craft-dev:status',
  launch: 'craft-dev:launch',
  stop: 'craft-dev:stop',
  setControl: 'craft-dev:set-control',
  restart: 'craft-dev:restart',
  build: 'craft-dev:build',
  apply: 'craft-dev:apply',
  reloadResources: 'craft-dev:reload-resources',
  command: 'craft-dev:command',
  screenshot: 'craft-dev:screenshot',
  render: 'craft-dev:render',
  logs: 'craft-dev:logs',
  crashes: 'craft-dev:crashes',
  sessionEvent: 'craft-dev:session-event',
  logEvent: 'craft-dev:log-event'
} as const
