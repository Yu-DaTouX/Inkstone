import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import type {
  ApplyResult,
  BuildResult,
  CommandResult,
  CompanionOwner,
  CreateFabricProjectRequest,
  CreateFabricProjectResult,
  CrashSummary,
  DevLaunchOptions,
  DevLogQuery,
  DevSessionInfo,
  DevStatusSnapshot,
  FabricVersionSet,
  JbrInfo,
  MappingFlavor
} from '../../shared/dev-api.ts'
import { createFabricProject } from './create-project.ts'
import { javaReleaseFor, resolveFabricVersions } from './fabric-meta.ts'
import { resolveJbr } from './jbr.ts'
import { DevProject } from './runner.ts'

export interface DevServiceOptions {
  dataDir: string
  javaPaths?: () => Promise<string[]>
  maxMemoryMb?: () => Promise<number>
  logPollMs?: number
}

interface Watch {
  file: string | null
  offset: number
  idle: number
}

const IDLE_POLLS_BEFORE_STOP = 40

export class DevService extends EventEmitter {
  private readonly options: DevServiceOptions
  private readonly projects = new Map<string, DevProject>()
  private readonly watches = new Map<string, Watch>()
  private timer: NodeJS.Timeout | null = null
  private javaPathsCache: string[] = []

  constructor(options: DevServiceOptions) {
    super()
    this.options = options
  }

  get runtimesDir(): string {
    return join(this.options.dataDir, 'runtimes')
  }

  private async refreshJavaPaths(): Promise<string[]> {
    this.javaPathsCache = (await this.options.javaPaths?.()) ?? []
    return this.javaPathsCache
  }

  private async project(projectDir: string): Promise<DevProject> {
    const dir = resolve(projectDir)
    const key = dir.toLowerCase()
    let project = this.projects.get(key)
    if (!project) {
      project = new DevProject(dir, {
        runtimesDir: this.runtimesDir,
        javaPaths: await this.refreshJavaPaths(),
        onLog: (text) => this.emit('log', { projectDir: dir, text }),
        onSession: (session) => this.emit('session', session)
      })
      this.projects.set(key, project)
    }
    this.watch(dir)
    return project
  }

  private watch(projectDir: string): void {
    const key = projectDir.toLowerCase()
    if (!this.watches.has(key)) this.watches.set(key, { file: null, offset: 0, idle: 0 })
    else this.watches.get(key)!.idle = 0
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.options.logPollMs ?? 750)
      this.timer.unref?.()
    }
  }

  private async poll(): Promise<void> {
    for (const [key, watch] of this.watches) {
      const project = this.projects.get(key)
      if (!project) continue
      try {
        const chunk = await project.readLogSince(watch.file, watch.offset)
        const fresh = chunk.file !== watch.file
        watch.file = chunk.file
        watch.offset = chunk.offset
        if (chunk.text) {
          watch.idle = 0
          for (const line of chunk.text.split(/\r?\n/)) if (line) this.emit('log', { projectDir: project.projectDir, text: line })
        } else if (!fresh) {
          watch.idle += 1
          if (watch.idle >= IDLE_POLLS_BEFORE_STOP && (await project.status()).state !== 'running') this.watches.delete(key)
        }
      } catch {
      }
    }
    if (!this.watches.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  fabricVersions(minecraftVersion: string, mappings: MappingFlavor = 'yarn'): Promise<FabricVersionSet> {
    return resolveFabricVersions(minecraftVersion, { mappings })
  }

  async createFabricProject(request: CreateFabricProjectRequest): Promise<CreateFabricProjectResult> {
    return createFabricProject(request, { javaPaths: await this.refreshJavaPaths() })
  }

  async jbr(minecraftVersion = '1.21.1'): Promise<JbrInfo> {
    return resolveJbr(javaReleaseFor(minecraftVersion), this.runtimesDir, await this.refreshJavaPaths())
  }

  async status(projectDir: string): Promise<DevStatusSnapshot> {
    const project = await this.project(projectDir)
    const session = await project.status()
    return { session, jbr: await project.jbr(session.minecraftVersion ?? (await project.readSpec())?.minecraftVersion ?? null) }
  }

  async launch(options: DevLaunchOptions): Promise<DevSessionInfo> {
    const maxMemoryMb = options.maxMemoryMb ?? (await this.options.maxMemoryMb?.())
    return (await this.project(options.projectDir)).launch({ ...options, maxMemoryMb })
  }

  async stop(projectDir: string): Promise<DevSessionInfo> {
    return (await this.project(projectDir)).stop()
  }

  async setControl(projectDir: string, owner: CompanionOwner): Promise<DevSessionInfo> {
    return (await this.project(projectDir)).setControl(owner)
  }

  async restart(options: DevLaunchOptions): Promise<DevSessionInfo> {
    const maxMemoryMb = options.maxMemoryMb ?? (await this.options.maxMemoryMb?.())
    return (await this.project(options.projectDir)).restart({ ...options, maxMemoryMb })
  }

  async build(projectDir: string): Promise<BuildResult> {
    return (await this.project(projectDir)).build()
  }

  async apply(projectDir: string, autoRestart = false): Promise<ApplyResult> {
    return (await this.project(projectDir)).apply({ autoRestart })
  }

  async reloadResources(projectDir: string): Promise<ApplyResult> {
    return (await this.project(projectDir)).reloadResources()
  }

  async command(projectDir: string, command: string): Promise<CommandResult> {
    return (await this.project(projectDir)).command(command)
  }

  async screenshot(projectDir: string): Promise<string> {
    const png = await (await this.project(projectDir)).image('/screenshot')
    return `data:image/png;base64,${png.toString('base64')}`
  }

  async render(projectDir: string, id: string, kind: 'item' | 'block' = 'item', size = 256): Promise<string> {
    const png = await (await this.project(projectDir)).image('/render', { id, kind, size })
    return `data:image/png;base64,${png.toString('base64')}`
  }

  async logs(query: DevLogQuery): Promise<string[]> {
    const { projectDir, ...rest } = query
    return (await this.project(projectDir)).logs(rest)
  }

  async crashes(projectDir: string): Promise<CrashSummary[]> {
    return (await this.project(projectDir)).crashes()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watches.clear()
    this.removeAllListeners()
  }
}
