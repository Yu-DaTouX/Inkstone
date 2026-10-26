import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, closeSync } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { JavaEntry } from '../../shared/dev-api.ts'
import type { ApplyResult, BuildResult, CommandResult, CompanionControl, CompanionOwner, CrashSummary, DevLaunchOptions, DevLogQuery, DevSessionInfo, JbrInfo } from '../../shared/dev-api.ts'
import { detectJava, pickJava } from './java.ts'
import { companionModDir, initScriptPath } from './assets.ts'
import { buildCompanionMod } from './companion-build.ts'
import { companionControl, companionImage, companionJarDirs, companionReachable, companionRequest, companionVariant, findCompanionJar, installCompanion, type CompanionEndpoint, type CompanionVariant } from './companion.ts'
import { compareVersions, javaReleaseFor } from './fabric-meta.ts'
import { cleanGradleOutput, parseGradleErrors, runGradle } from './gradle.ts'
import { hotswapClasses } from './hotswap.ts'
import { jbrDownloadHint, resolveJbr, supportsEnhancedRedefinition } from './jbr.ts'
import { downloadJbr } from './jbr-download.ts'
import { filterLogDetails, listCrashes, tailFile } from './logs.ts'
import { classifyResources, diffManifest, isLangFile, langRegistrationCandidates, mixinPackagesFrom, registrationCandidates, scanManifest, type FileManifest } from './manifest.ts'
import {
  agentWindowJvmArgs,
  writeLaunchArgFile,
  splitLaunchArgs,
  stablePlayerArgs,
  findMixinAgent,
  freePort,
  killTree,
  pidAlive,
  prepareRunDir,
  readJson,
  statePaths,
  stripJvmArgs,
  withWindowSize,
  worldExists,
  readOptions,
  optionsPath,
  writeJson,
  writeOptions,
  type LaunchSpec,
  type SessionFile
} from './session.ts'

export const DEFAULT_WORLD = 'inkstone-test'
const READY_TIMEOUT_MS = 300_000
const WORLD_SETTLE_MS = 1500

export interface LaunchEnv {
  gamemode?: string
  difficulty?: string
  lang?: string
  time?: string
  weather?: string
}

export interface LaunchOptions extends DevLaunchOptions {
  env?: LaunchEnv
}

export const LAUNCH_ENV_KEYS = ['gamemode', 'difficulty', 'lang', 'time', 'weather'] as const

export function environmentCommands(env: LaunchEnv): string[] {
  const commands: string[] = []
  if (env.difficulty) commands.push(`difficulty ${env.difficulty}`)
  if (env.gamemode) commands.push(`gamemode ${env.gamemode}`)
  if (env.time) commands.push(`time set ${env.time}`)
  if (env.weather) commands.push(`weather ${env.weather}`)
  return commands
}

export interface DevProjectOptions {
  runtimesDir: string
  javaPaths?: string[]
  companionJar?: string | null
  companionDirs?: string[]
  onLog?: (text: string) => void
  onSession?: (session: DevSessionInfo) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emptyApply(build: BuildResult): ApplyResult {
  return { build, hotswap: null, resourcesReloaded: false, dataReloaded: false, changedAssets: [], changedData: [], restartNeeded: false, restarted: false, notes: [] }
}

export class DevProject {
  readonly projectDir: string
  private readonly options: DevProjectOptions
  private readonly paths: ReturnType<typeof statePaths>
  private queue: Promise<unknown> = Promise.resolve()
  private javaList: Promise<JavaEntry[]> | null = null
  private gradleJava: string | null = null
  private message: string | null = null
  private state: DevSessionInfo['state'] | null = null

  constructor(projectDir: string, options: DevProjectOptions) {
    this.projectDir = projectDir
    this.options = options
    this.paths = statePaths(projectDir)
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private log(text: string): void {
    this.options.onLog?.(text)
  }

  private javas(): Promise<JavaEntry[]> {
    this.javaList ??= detectJava(this.options.javaPaths ?? [])
    return this.javaList
  }

  private async pickGradleJava(minimum: number): Promise<string> {
    if (process.env.INKSTONE_GRADLE_JAVA) return process.env.INKSTONE_GRADLE_JAVA
    const list = await this.javas()
    const hit = pickJava(list, minimum) ?? list[0]
    if (!hit) throw new Error('没有找到可以运行 Gradle 的 Java（需要 17 以上）')
    return hit.path
  }

  async gradle(tasks: string[], args: string[] = []): Promise<{ ok: boolean; output: string; durationMs: number }> {
    this.gradleJava ??= await this.pickGradleJava(25)
    let result = await runGradle(this.projectDir, tasks, { javaPath: this.gradleJava, initScripts: [initScriptPath()], args: ['--no-configuration-cache', ...args], onLine: (line) => this.log(`[gradle] ${line}`) })
    const needed = result.output.match(/requires at least JVM runtime version (\d+)/)
    if (!result.ok && needed) {
      const better = pickJava(await this.javas(), Number(needed[1]))
      if (better && better.path !== this.gradleJava) {
        this.gradleJava = better.path
        result = await runGradle(this.projectDir, tasks, { javaPath: this.gradleJava, initScripts: [initScriptPath()], args: ['--no-configuration-cache', ...args], onLine: (line) => this.log(`[gradle] ${line}`) })
      } else if (!better) {
        result = { ...result, output: `${result.output}\n需要 Java ${needed[1]} 运行 Gradle，但本机没有找到。` }
      }
    }
    return result
  }

  async readSpec(): Promise<LaunchSpec | null> {
    return readJson<LaunchSpec>(this.paths.spec)
  }

  private async refreshSpec(): Promise<{ spec: LaunchSpec | null; build: BuildResult }> {
    const result = await this.gradle(['inkstoneLaunchSpec'], [`-Dinkstone.specOut=${this.paths.spec}`])
    const build: BuildResult = { ok: result.ok, durationMs: result.durationMs, tasks: ['inkstoneLaunchSpec'], output: cleanGradleOutput(result.output).slice(-20_000), errors: result.ok ? [] : parseGradleErrors(result.output) }
    return { spec: result.ok ? await this.readSpec() : null, build }
  }

  private async specOrRefresh(): Promise<LaunchSpec> {
    const existing = await this.readSpec()
    if (existing) return existing
    const { spec, build } = await this.refreshSpec()
    if (!spec) throw new Error(`导出启动参数失败：\n${build.errors.join('\n') || build.output.slice(-4000)}`)
    return spec
  }

  private classRoots(spec: LaunchSpec): string[] {
    return spec.sourceSets.flatMap((set) => set.classesDirs)
  }

  private resourceRoots(spec: LaunchSpec): string[] {
    return spec.sourceSets.map((set) => set.resourcesDir).filter((dir): dir is string => !!dir)
  }

  private scanClasses(spec: LaunchSpec): Promise<FileManifest> {
    return scanManifest(this.classRoots(spec), (path) => path.endsWith('.class'))
  }

  private async langKeys(spec: LaunchSpec): Promise<Set<string>> {
    const keys = new Set<string>()
    for (const root of this.resourceRoots(spec)) {
      const manifest = await scanManifest([root], isLangFile).catch(() => ({}) as FileManifest)
      for (const path of Object.keys(manifest)) {
        try {
          const parsed = JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>
          for (const key of Object.keys(parsed)) keys.add(key)
        } catch {
        }
      }
    }
    return keys
  }

  private scanResources(spec: LaunchSpec): Promise<FileManifest> {
    return scanManifest(this.resourceRoots(spec))
  }

  private async mixinPackages(spec: LaunchSpec): Promise<string[]> {
    const configs: Array<{ package?: unknown }> = []
    for (const root of this.resourceRoots(spec)) {
      const mod = await readJson<{ mixins?: unknown[] }>(join(root, 'fabric.mod.json'))
      for (const entry of mod?.mixins ?? []) {
        const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry ? (entry as { config?: unknown }).config : null
        if (typeof name !== 'string') continue
        const config = await readJson<{ package?: unknown }>(join(root, name))
        if (config) configs.push(config)
      }
    }
    return mixinPackagesFrom(configs)
  }

  async build(): Promise<BuildResult> {
    return this.serial(() => this.buildNow('classes'))
  }

  private async buildNow(kind: 'classes' | 'resources'): Promise<BuildResult> {
    const startedAt = Date.now()
    const spec = await this.specOrRefresh()
    const tasks = spec.sourceSets.map((set) => (kind === 'classes' ? set.classesTask : set.resourcesTask))
    const result = await this.gradle(tasks)
    return { ok: result.ok, durationMs: Date.now() - startedAt, tasks, output: cleanGradleOutput(result.output).slice(-20_000), errors: result.ok ? [] : parseGradleErrors(result.output) }
  }

  private async session(): Promise<SessionFile | null> {
    return readJson<SessionFile>(this.paths.session)
  }

  private endpoint(session: SessionFile | null): CompanionEndpoint | null {
    return session?.companionPort && session.token ? { port: session.companionPort, token: session.token } : null
  }

  private async liveSession(): Promise<SessionFile> {
    const session = await this.session()
    if (!session || !pidAlive(session.pid)) throw new Error('开发客户端没有在运行，先启动它')
    return session
  }

  private async liveEndpoint(): Promise<CompanionEndpoint> {
    const endpoint = this.endpoint(await this.liveSession())
    if (!endpoint) throw new Error('这个开发实例没有装伴随 mod（MC 版本不支持或 jar 缺失）')
    return endpoint
  }

  private async controlAt(endpoint: CompanionEndpoint | null): Promise<CompanionControl | null> {
    if (!endpoint) return null
    try {
      return await companionControl(endpoint)
    } catch {
      return null
    }
  }

  async control(): Promise<CompanionControl | null> {
    const session = await this.session()
    return pidAlive(session?.pid) ? this.controlAt(this.endpoint(session)) : null
  }

  async setControl(owner: CompanionOwner): Promise<DevSessionInfo> {
    return this.serial(async () => {
      await companionControl(await this.liveEndpoint(), owner)
      return this.emitSession()
    })
  }

  async status(): Promise<DevSessionInfo> {
    const session = await this.session()
    const alive = pidAlive(session?.pid)
    const endpoint = alive ? this.endpoint(session) : null
    const companion = endpoint ? await companionReachable(endpoint) : null
    const crashes = !alive && session ? (await listCrashes((await this.readSpec())?.workingDir ?? join(this.projectDir, 'run'), 1)).filter((crash) => crash.at >= session.startedAt) : []
    const state: DevSessionInfo['state'] = this.state ?? (alive ? 'running' : session ? (crashes.length || (session.exitCode !== null && session.exitCode !== 0) ? 'crashed' : 'exited') : 'idle')
    return {
      projectDir: this.projectDir,
      pid: alive ? (session?.pid ?? null) : null,
      state,
      startedAt: session?.startedAt ?? null,
      javaPath: session?.javaPath ?? null,
      jbr: session?.jbr ?? false,
      enhancedRedefinition: session?.enhanced ?? false,
      mixinHotswap: session?.mixinAgent ?? false,
      minecraftVersion: session?.minecraftVersion ?? null,
      jdwpPort: alive ? (session?.jdwpPort ?? null) : null,
      companionPort: alive ? (session?.companionPort ?? null) : null,
      companionReady: !!companion,
      world: typeof companion?.world === 'string' ? companion.world : (session?.world ?? null),
      logFile: session?.logFile ?? null,
      exitCode: session?.exitCode ?? null,
      crashReport: crashes[0]?.file ?? null,
      message: this.message ?? session?.message ?? null,
      control: companion ? await this.controlAt(endpoint) : null
    }
  }

  private async emitSession(): Promise<DevSessionInfo> {
    const info = await this.status()
    this.options.onSession?.(info)
    return info
  }

  private async setState(state: DevSessionInfo['state'] | null, message?: string | null): Promise<void> {
    this.state = state
    if (message !== undefined) this.message = message
    await this.emitSession()
  }

  async jbr(minecraftVersion: string | null): Promise<JbrInfo> {
    return resolveJbr(javaReleaseFor(minecraftVersion ?? '1.21.1'), this.options.runtimesDir, this.options.javaPaths ?? [])
  }

  private async gameJava(release: number, options: DevLaunchOptions): Promise<{ path: string; jbr: boolean; enhanced: boolean; hint: string | null }> {
    if (options.javaPath) {
      const own = await resolveJbr(release, this.options.runtimesDir, [options.javaPath])
      if (own.path?.toLowerCase() === options.javaPath.toLowerCase() && own.enhancedRedefinition) return { path: options.javaPath, jbr: true, enhanced: true, hint: null }
    }
    const jbrInfo = await resolveJbr(release, this.options.runtimesDir, this.options.javaPaths ?? [])
    if (jbrInfo.found && jbrInfo.path && jbrInfo.enhancedRedefinition) return { path: jbrInfo.path, jbr: true, enhanced: true, hint: null }
    const log = (line: string): void => this.log(line)
    let downloaded: string
    try {
      log(`[inkstone] 本机没有可用的 JBR ${release}，开始自动下载（约 100MB，只需一次）`)
      downloaded = await downloadJbr(release, this.options.runtimesDir, log)
    } catch (error) {
      throw new Error(`开发客户端必须用 JBR ${release} 启动，自动下载失败：${error instanceof Error ? error.message : String(error)}\n${jbrDownloadHint(release, this.options.runtimesDir)}`)
    }
    if (!(await supportsEnhancedRedefinition(downloaded))) throw new Error(`下载的 JBR（${downloaded}）不支持增强热替换\n${jbrDownloadHint(release, this.options.runtimesDir)}`)
    return { path: downloaded, jbr: true, enhanced: true, hint: `已自动下载 JBR ${release}：${downloaded}` }
  }

  private async companionJar(variant: CompanionVariant): Promise<string | null> {
    if (this.options.companionJar !== undefined) return this.options.companionJar
    const dir = companionModDir(variant.subdir)
    const found = await findCompanionJar(companionJarDirs(dir, this.options.companionDirs), variant)
    const version = found ? basename(found).match(variant.jar)?.[1] : null
    if (found && version && compareVersions(version, '0.1.1') >= 0) return found
    if (!existsSync(join(dir, 'build.gradle'))) {
      if (found) throw new Error('伴随 mod 需要 0.1.1 或更新版本，请更新 Minecraft 插件后重试')
      return null
    }
    this.log(`[inkstone] ${found ? '伴随 mod 需要升级' : '首次使用'}，正在构建伴随 mod`)
    this.gradleJava ??= await this.pickGradleJava(25)
    const built = await buildCompanionMod({ javaPath: this.gradleJava, variant, onLine: (line) => this.log(`[companion] ${line}`) })
    if (!built.ok) this.log(`[inkstone] 伴随 mod 构建失败：${built.errors.join('\n')}`)
    return built.jar
  }

  launch(options: LaunchOptions): Promise<DevSessionInfo> {
    return this.serial(() => this.launchNow(options))
  }

  async workingDir(): Promise<string> {
    const spec = await this.readSpec()
    return spec?.workingDir ?? join(this.projectDir, 'run')
  }

  async clientOptions(): Promise<{ file: string; values: Record<string, string> }> {
    const dir = await this.workingDir()
    return { file: optionsPath(dir), values: await readOptions(dir) }
  }

  async saveClientOptions(values: Record<string, string>): Promise<{ file: string; values: Record<string, string> }> {
    const dir = await this.workingDir()
    const file = await writeOptions(dir, values)
    return { file, values: await readOptions(dir) }
  }

  private async launchNow(options: LaunchOptions): Promise<DevSessionInfo> {
    if (options.username !== undefined && !/^[A-Za-z0-9_]{1,16}$/.test(options.username)) throw new Error('开发玩家名必须是 1–16 位英文字母、数字或下划线')
    const existing = await this.session()
    if (existing && pidAlive(existing.pid)) await this.stopNow()
    await this.setState('building', '正在构建并导出启动参数')
    const { spec, build } = await this.refreshSpec()
    if (!spec) {
      await this.setState(null, `构建失败：${build.errors[0] ?? '见 Gradle 输出'}`)
      throw new Error(`构建失败：\n${build.errors.join('\n') || build.output.slice(-4000)}`)
    }
    await this.setState('starting', '正在启动开发客户端')
    const release = javaReleaseFor(spec.minecraftVersion ?? '1.21.1')
    const java = await this.gameJava(release, options)
    await prepareRunDir(spec.workingDir, options.env?.lang ? { lang: options.env.lang } : {})
    const world = options.world === null ? null : (options.world ?? DEFAULT_WORLD)
    const notes: string[] = []
    let companionPort: number | null = null
    let token: string | null = null
    const variant = companionVariant(spec.minecraftVersion)
    const jar = variant ? await this.companionJar(variant) : null
    if (jar) {
      await installCompanion(jar, join(spec.workingDir, 'mods'))
      companionPort = await freePort()
      token = randomBytes(24).toString('hex')
    } else {
      notes.push(variant ? `没有找到 ${variant.id} 版伴随 mod jar（companion-mod${variant.subdir ? `/${variant.subdir}` : ''}/build/libs），截图、重载、执行命令不可用` : `伴随 mod 暂不支持 Minecraft ${spec.minecraftVersion}（支持 1.21–1.21.1、26.1.x）`)
    }
    const jdwpPort = await freePort()
    const mixinAgent = findMixinAgent(spec.classpath)
    if (!mixinAgent) notes.push('类路径里没有 sponge-mixin，Mixin 改动只能重启生效')
    const jvmArgs = [
      ...stripJvmArgs(spec.jvmArgs),
      `-Xmx${options.maxMemoryMb ?? 4096}m`,
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${jdwpPort}`,
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      ...(java.enhanced ? ['-XX:+AllowEnhancedClassRedefinition'] : []),
      ...(mixinAgent ? [`-javaagent:${mixinAgent}`] : []),
      ...agentWindowJvmArgs(this.projectDir),
      ...(companionPort && token ? [`-Dinkstone.companion.port=${companionPort}`, `-Dinkstone.companion.token=${token}`] : [])
    ]
    const username = options.username ?? existing?.username
    const gameArgs = withWindowSize(stablePlayerArgs(spec.args, username))
    if (world) {
      if (worldExists(spec.workingDir, world)) gameArgs.push('--quickPlaySingleplayer', world)
      else if (companionPort) jvmArgs.push(`-Dinkstone.companion.world=${world}`)
      else notes.push(`测试世界 ${world} 还不存在，没有伴随 mod 无法自动创建`)
    }
    await mkdir(this.paths.logs, { recursive: true })
    const { fileArgs, commandArgs } = splitLaunchArgs(jvmArgs)
    await writeLaunchArgFile(this.paths.argFile, [...fileArgs, '-cp', spec.classpath.join(process.platform === 'win32' ? ';' : ':'), spec.mainClass])
    const logFile = join(this.paths.logs, `client-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    const fd = openSync(logFile, 'a')
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.environment }
    delete env.ELECTRON_RUN_AS_NODE
    delete env._JAVA_OPTIONS
    const child = spawn(java.path, [...commandArgs, `@${this.paths.argFile}`, ...gameArgs], { cwd: spec.workingDir, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: false })
    closeSync(fd)
    const startedAt = Date.now()
    const session: SessionFile = {
      version: 1,
      pid: child.pid ?? null,
      startedAt,
      javaPath: java.path,
      jbr: java.jbr,
      enhanced: java.enhanced,
      mixinAgent: !!mixinAgent,
      jdwpPort,
      companionPort,
      token,
      world,
      username,
      logFile,
      minecraftVersion: spec.minecraftVersion,
      owner: process.pid,
      exitCode: null,
      stoppedAt: null,
      message: notes.join('\n') || null,
      jbrHint: java.hint
    }
    await writeJson(this.paths.session, session)
    await writeJson(this.paths.classes, await this.scanClasses(spec))
    await writeJson(this.paths.resources, await this.scanResources(spec))
    child.on('exit', (code) => {
      void (async () => {
        const current = await this.session()
        if (current && current.pid === session.pid) await writeJson(this.paths.session, { ...current, exitCode: code, stoppedAt: Date.now() })
        await this.emitSession()
      })()
    })
    child.unref()
    this.log(`[inkstone] 开发客户端已启动 pid=${child.pid} java=${java.path}${java.enhanced ? '（JBR 增强热替换）' : java.jbr ? '（JBR）' : '（普通 JDK，只能热替换方法体）'}`)
    await this.setState(null, session.message)
    const waitFor = options.waitFor ?? (world && companionPort ? 'world' : companionPort ? 'companion' : 'process')
    if (waitFor !== 'process') await this.waitReady(session, waitFor, options.timeoutMs ?? READY_TIMEOUT_MS)
    if (options.env && world && companionPort && token) {
      const endpoint = { port: companionPort, token }
      const applied: string[] = []
      for (const command of environmentCommands(options.env)) {
        const result = await this.commandWith(endpoint, command)
        applied.push(result.ok ? `/${command} 已执行` : command.startsWith('difficulty ') ? `/${command} 无需变更（已是该难度）` : `/${command} 失败：${result.error ?? result.output.join(' ')}`)
      }
      if (applied.length) {
        notes.push(`启动环境：${applied.join('；')}`)
        await writeJson(this.paths.session, { ...session, message: notes.join('\n') || null })
        await this.setState(null, notes.join('\n') || null)
      }
    } else if (options.env && environmentCommands(options.env).length) {
      notes.push(world ? '没有伴随 mod，环境参数（gamemode/difficulty/time/weather）没有执行；进世界后用 mc_command 设' : '停在标题界面，环境参数只处理了 lang；进入世界后用 mc_command 设其余项')
      await writeJson(this.paths.session, { ...session, message: notes.join('\n') || null })
      await this.setState(null, notes.join('\n') || null)
    }
    return this.emitSession()
  }

  private async waitReady(session: SessionFile, waitFor: 'companion' | 'world', timeoutMs: number): Promise<void> {
    const endpoint = this.endpoint(session)
    if (!endpoint) return
    const deadline = Date.now() + timeoutMs
    let playingSince = 0
    while (Date.now() < deadline) {
      if (!pidAlive(session.pid)) {
        const crash = (await listCrashes((await this.readSpec())?.workingDir ?? join(this.projectDir, 'run'), 1))[0]
        throw new Error(`开发客户端启动后退出${crash ? `，崩溃报告：${crash.file}\n${crash.description ?? ''}\n${crash.exception ?? ''}` : '，请看日志'}`)
      }
      const status = await companionReachable(endpoint)
      if (status && waitFor === 'companion') return
      const playing = status?.playing === true || (status?.playing === undefined && status?.inWorld === true && status?.loading !== true)
      playingSince = playing ? playingSince || Date.now() : 0
      if (playingSince && Date.now() - playingSince >= WORLD_SETTLE_MS) return
      await sleep(500)
    }
    throw new Error(`等待开发客户端${waitFor === 'world' ? '进入世界' : '就绪'}超时`)
  }

  stop(): Promise<DevSessionInfo> {
    return this.serial(() => this.stopNow())
  }

  private async stopNow(): Promise<DevSessionInfo> {
    const session = await this.session()
    if (!session || !pidAlive(session.pid)) return this.emitSession()
    await this.setState('stopping', null)
    const endpoint = this.endpoint(session)
    if (endpoint) {
      try {
        await companionRequest(endpoint, '/shutdown', {}, 5000)
      } catch {
      }
      const deadline = Date.now() + 20_000
      while (pidAlive(session.pid) && Date.now() < deadline) await sleep(500)
    }
    if (pidAlive(session.pid) && session.pid) await killTree(session.pid)
    const deadline = Date.now() + 5000
    while (pidAlive(session.pid) && Date.now() < deadline) await sleep(200)
    const current = await this.session()
    if (current) await writeJson(this.paths.session, { ...current, stoppedAt: Date.now() })
    await this.setState(null, null)
    return this.emitSession()
  }

  restart(options: LaunchOptions): Promise<DevSessionInfo> {
    return this.serial(async () => {
      const session = await this.session()
      const world = options.world !== undefined ? options.world : (session?.world ?? DEFAULT_WORLD)
      await this.stopNow()
      return this.launchNow({ ...options, world })
    })
  }

  apply(options: { autoRestart?: boolean } = {}): Promise<ApplyResult> {
    return this.serial(() => this.applyNow('classes', options.autoRestart ?? false))
  }

  reloadResources(): Promise<ApplyResult> {
    return this.serial(() => this.applyNow('resources', false))
  }

  private async applyNow(kind: 'classes' | 'resources', autoRestart: boolean): Promise<ApplyResult> {
    const spec = await this.specOrRefresh()
    const session = await this.session()
    const running = !!session && pidAlive(session.pid)
    const beforeClasses = (await readJson<FileManifest>(this.paths.classes)) ?? (await this.scanClasses(spec))
    const beforeResources = (await readJson<FileManifest>(this.paths.resources)) ?? (await this.scanResources(spec))
    const langBefore = await this.langKeys(spec)
    const build = await this.buildNow(kind)
    const result = emptyApply(build)
    if (!build.ok) {
      result.notes.push('编译失败，游戏里仍是上一次成功的版本')
      return result
    }
    const afterClasses = kind === 'classes' ? await this.scanClasses(spec) : beforeClasses
    const afterResources = await this.scanResources(spec)
    const classDiff = diffManifest(beforeClasses, afterClasses)
    const resourceDiff = diffManifest(beforeResources, afterResources)
    const resources = classifyResources([...resourceDiff.changed, ...resourceDiff.added, ...resourceDiff.removed])
    result.changedAssets = resources.assets
    result.changedData = resources.data
    if (!running || !session) {
      await writeJson(this.paths.classes, afterClasses)
      await writeJson(this.paths.resources, afterResources)
      result.notes.push('开发客户端没有在运行，改动会在下次启动时生效')
      return result
    }
    const nextClasses = { ...afterClasses }
    if (kind === 'classes' && (classDiff.changed.length || classDiff.added.length || classDiff.removed.length)) {
      const swap = await hotswapClasses({ jdwpPort: session.jdwpPort, classRoots: this.classRoots(spec), diff: classDiff, mixinPackages: await this.mixinPackages(spec), mixinHotswap: session.mixinAgent === true })
      for (const path of swap.failedPaths) {
        if (beforeClasses[path]) nextClasses[path] = beforeClasses[path]
        else delete nextClasses[path]
      }
      const { failedPaths: _failed, ...hotswap } = swap
      result.hotswap = hotswap
      if (swap.restartNeeded) result.restartNeeded = true
      if (!session.enhanced && swap.restartReasons.some((item) => item.reason === 'schema-change')) {
        result.notes.push('当前是普通 JDK，只能热替换方法体；用 JBR 启动可以热替换新增方法/字段')
      }
    }
    if (resources.metadata.length) {
      result.restartNeeded = true
      result.hotswap ??= { swapped: [], added: [], removed: [], skippedNotLoaded: [], restartNeeded: true, restartReasons: [] }
      result.hotswap.restartReasons.push({ reason: 'metadata', detail: `改了 ${resources.metadata.join('、')}，需要重启` })
    }
    const endpoint = this.endpoint(session)
    const candidates = [...registrationCandidates(resourceDiff.added), ...langRegistrationCandidates(langBefore, await this.langKeys(spec))]
    const unregistered = endpoint ? await this.unregistered(endpoint, [...new Map(candidates.map((item) => [`${item.registry}|${item.id}`, item])).values()]) : []
    if (unregistered.length) {
      result.restartNeeded = true
      result.hotswap ??= { swapped: [], added: [], removed: [], skippedNotLoaded: [], restartNeeded: true, restartReasons: [] }
      result.hotswap.restartNeeded = true
      result.hotswap.restartReasons.push({ reason: 'registration', detail: `新资源对应的 ${unregistered.join('、')} 还没注册进游戏：注册表在启动时冻结，新物品/方块要重启才会出现` })
    }
    if (endpoint && (resources.assets.length || kind === 'resources')) {
      await companionRequest(endpoint, '/reload-resources', {}, 240_000)
      result.resourcesReloaded = true
    }
    if (endpoint && resources.data.length) {
      const reload = await this.commandWith(endpoint, 'reload')
      result.dataReloaded = reload.ok
      if (!reload.ok) result.notes.push(`/reload 失败：${reload.error ?? reload.output.join(' ')}`)
    }
    if (!endpoint && (resources.assets.length || resources.data.length)) result.notes.push('没有伴随 mod，资源和数据改动需要手动按 F3+T 或执行 /reload')
    await writeJson(this.paths.classes, nextClasses)
    await writeJson(this.paths.resources, afterResources)
    if (result.restartNeeded && autoRestart) {
      await this.stopNow()
      await this.launchNow({ projectDir: this.projectDir, world: session.world })
      result.restarted = true
    }
    return result
  }

  private async unregistered(endpoint: CompanionEndpoint, candidates: Array<{ registry: 'item' | 'block'; id: string }>): Promise<string[]> {
    const missing: string[] = []
    for (const { registry, id } of candidates.slice(0, 20)) {
      try {
        const reply = (await companionRequest(endpoint, '/registry', { registry: `minecraft:${registry}`, filter: id, limit: 50 }, 15_000)) as { ids?: unknown }
        const ids = Array.isArray(reply.ids) ? reply.ids.map(String) : null
        if (ids && !ids.includes(id)) missing.push(`${registry === 'item' ? '物品' : '方块'} ${id}`)
      } catch {
      }
    }
    return missing
  }

  private async commandWith(endpoint: CompanionEndpoint, command: string): Promise<CommandResult> {
    try {
      const reply = (await companionRequest(endpoint, '/command', { command }, 60_000)) as { ok?: unknown; output?: unknown }
      const output = Array.isArray(reply.output) ? reply.output.map(String) : []
      return { command, ok: reply.ok !== false, output, error: null }
    } catch (error) {
      return { command, ok: false, output: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async command(command: string): Promise<CommandResult> {
    return this.commandWith(await this.liveEndpoint(), command)
  }

  async companion(path: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return companionRequest(await this.liveEndpoint(), path, body, timeoutMs)
  }

  async image(path: string, body: Record<string, unknown> = {}): Promise<Buffer> {
    return companionImage(await this.liveEndpoint(), path, body)
  }

  async logs(query: Omit<DevLogQuery, 'projectDir'> = {}): Promise<string[]> {
    return (await this.logDetails(query)).lines
  }

  async logDetails(query: Omit<DevLogQuery, 'projectDir'> = {}): Promise<{ lines: string[]; matchedLines: number }> {
    const session = await this.session()
    const file = session?.logFile
    if (!file || !existsSync(file)) return { lines: [], matchedLines: 0 }
    return filterLogDetails(await tailFile(file), query)
  }

  async crashes(limit = 5): Promise<CrashSummary[]> {
    const spec = await this.readSpec()
    return listCrashes(spec?.workingDir ?? join(this.projectDir, 'run'), limit)
  }

  async readLogSince(file: string | null, offset: number): Promise<{ file: string | null; text: string; offset: number }> {
    const session = await this.session()
    const current = session?.logFile ?? null
    if (!current || !existsSync(current)) return { file: current, text: '', offset: 0 }
    const start = current === file ? offset : 0
    const handle = await open(current, 'r')
    try {
      const size = (await handle.stat()).size
      if (size <= start) return { file: current, text: '', offset: size < start ? 0 : start }
      const length = Math.min(size - start, 1024 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const lastNewline = buffer.lastIndexOf(0x0a)
      const usable = lastNewline >= 0 ? lastNewline + 1 : length === 1024 * 1024 ? length : 0
      return { file: current, text: buffer.subarray(0, usable).toString('utf8'), offset: start + usable }
    } finally {
      await handle.close()
    }
  }
}
