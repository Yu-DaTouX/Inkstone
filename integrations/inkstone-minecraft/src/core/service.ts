import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { rename, readFile } from 'node:fs/promises'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { Account, FolderTarget, InstallKind, InstallRequest, InstanceInfo, JavaEntry, LauncherSettings, LaunchRequest, LaunchStatus, LoaderVersions, LogLine, MinecraftVersionList, PclSnapshot, SkinInfo, TaskProgress } from '../shared/api.ts'
import type { CrashActionRequest, CrashActionResult, CrashDiagnosis, CrashExportResult, CrashRecordSummary } from '../shared/crash-api.ts'
import type { LaunchEffective, LaunchStep, LaunchStepId, PreflightReport, PreflightRequest, SettingSource } from '../shared/launch-api.ts'
import type { LoaderKind } from '../shared/api.ts'
import type { ContentCategory, ContentInstallRequest, ContentSearchQuery, ModpackInstallRequest, ModpackSummary } from '../shared/download-api.ts'
import type { InstanceOverride, InstanceOverview, ModBatchResult, ModInstallRequest, ModListResult, ModrinthProject, ModrinthSearchQuery, ModrinthSearchResult, ModrinthVersion, ModUpdateCheckResult, ModUpdateRequest } from '../shared/mods-api.ts'
import { accountFromPcl, mergeAccounts, offlineAccount, validOfflineName } from './accounts.ts'
import { InstanceIconCache } from './instance-icons.ts'
import { buildOverview, directorySize, EMPTY_OVERRIDE, InstanceSettingsStore, lastPlayedAt, resolveSettings } from './instance-settings.ts'
import { copyInstance as copyVersionDir, instanceIconOptions as readIconOptions, InstanceIconStore, listScreenshots, listTrashedInstances, normalizeServerAddress, readIconOption, renameInstance as renameVersionDir, resourceList as readResources, restoreTrashedInstance, serverArgs, toggleResourcePack, trashInstance as trashVersionDir, trashResource } from './version-ops.ts'
import type { CopyInstanceResult, InstanceIconKind, InstanceIconOption, InstanceTrashRecord, ResourceKind, ScreenshotEntry, VersionResources } from '../shared/version-api.ts'
import { ModsManager, type InstanceContext } from './mods/manager.ts'
import { collectDependencyNeeds } from './mods/deps.ts'
import { installFabric, installQuilt } from './install/loaders.ts'
import { listFabricLoaders, listMinecraftVersions, listQuiltLoaders } from './install/list.ts'
import { installForge, listForgeLoaders } from './install/forge.ts'
import { installNeoForge, listNeoForgeLoaders } from './install/neoforge.ts'
import { quickCheck, repairInstance } from './install/repair.ts'
import { installVanilla } from './install/vanilla.ts'
import { buildCrashActions } from './crash/actions.ts'
import { CrashCenter, type CrashRunContext } from './crash/index.ts'
import { installMissingDependencies } from './crash/deps.ts'
import { modNames } from './crash/mods.ts'
import { normalizeExitCode } from './crash/collect.ts'
import { preflightLaunch } from './crash/preflight.ts'
import { applicableRules } from './crash/rules.ts'
import { TaskCenter } from './tasks.ts'
import { listInstances, readInstance } from './instances.ts'
import { detectJava, pickJava } from './java.ts'
import { describeLaunchCommand, initialLaunchSteps, launchOffline, updateLaunchStep } from './launch.ts'
import { normalizeFolder, readPclSnapshot, readPclVersionSetup } from './pcl-import.ts'
import { dataDir, SettingsStore } from './settings.ts'
import { SkinCache } from './skins.ts'
import { CommunityClient } from './download/community.ts'
import { cleanupCancelledInstall } from './install/cleanup.ts'
import { defaultModpackName, importModpack as importModpackFile, inspectModpack, sanitizeVersionName } from './install/mrpack.ts'
import { installTypeOf, projectTypeOf } from './download/community.ts'
import type { TaskHandle } from './tasks.ts'

const LOG_LIMIT = 2000
const LIST_CACHE_MS = 10 * 60 * 1000
const STARTUP_FATAL_DELAY_MS = 6000
const SETTING_SOURCE_LABEL: Record<SettingSource, string> = { instance: '单版本设置', pcl: 'PCL 设置', global: '全局' }

function isStartupFatal(loader: LoaderKind, text: string): boolean {
  return applicableRules(loader).some((rule) => rule.confidence === 'high' && rule.match.some((pattern) => pattern.test(text)))
}

function loaderLabel(kind: InstallKind): string {
  if (kind === 'fabric') return 'Fabric'
  if (kind === 'quilt') return 'Quilt'
  if (kind === 'forge') return 'Forge'
  if (kind === 'neoforge') return 'NeoForge'
  return '原版'
}

function validVersionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\\/:*?"<>|]/.test(id) && id !== '.' && id !== '..'
}

export interface CraftServiceOptions {
  dataDir?: string
  appData?: string
  pclLauncherDirs?: string[]
}

const IDLE: LaunchStatus = { state: 'idle', versionId: null, pid: null, exitCode: null, error: null, crashReport: null, javaPath: null }

export class CraftService extends EventEmitter {
  readonly dataDir: string
  private readonly store: SettingsStore
  private readonly appData: string
  private readonly pclLauncherDirs: string[]
  private readonly skins: SkinCache
  readonly mods: ModsManager
  readonly instanceSettings: InstanceSettingsStore
  private readonly icons = new InstanceIconCache()
  private readonly customIcons: InstanceIconStore
  readonly tasks = new TaskCenter()
  private readonly community = new CommunityClient()
  private javaCache: Promise<JavaEntry[]> | null = null
  private versionCache: { at: number; value: MinecraftVersionList } | null = null
  private readonly loaderCache = new Map<string, { at: number; value: LoaderVersions }>()
  private child: ChildProcess | null = null
  private current: LaunchStatus = { ...IDLE }
  private readonly logLines: LogLine[] = []
  private readonly crash: CrashCenter
  private launchAbort: AbortController | null = null
  private runLines: LogLine[] = []
  private steps: LaunchStep[] = initialLaunchSteps()

  constructor(options: CraftServiceOptions = {}) {
    super()
    this.dataDir = options.dataDir ?? dataDir()
    this.store = new SettingsStore(join(this.dataDir, 'settings.json'))
    this.appData = options.appData ?? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    this.pclLauncherDirs = options.pclLauncherDirs ?? []
    this.skins = new SkinCache(join(this.dataDir, 'skins'))
    this.mods = new ModsManager({ dataDir: this.dataDir })
    this.instanceSettings = new InstanceSettingsStore(join(this.dataDir, 'instances.json'))
    this.crash = new CrashCenter(join(this.dataDir, 'crash'))
    this.customIcons = new InstanceIconStore(this.dataDir)
  }

  settings(): Promise<LauncherSettings> {
    return this.store.load()
  }

  async updateSettings(patch: Partial<LauncherSettings>): Promise<LauncherSettings> {
    if (patch.extraJavaPaths) this.javaCache = null
    return this.store.update(patch)
  }

  instances(folder: string): Promise<InstanceInfo[]> {
    return listInstances(normalizeFolder(folder))
  }

  async minecraftVersions(): Promise<MinecraftVersionList> {
    if (this.versionCache && Date.now() - this.versionCache.at < LIST_CACHE_MS) return this.versionCache.value
    const settings = await this.store.load()
    const value = await listMinecraftVersions({ source: settings.downloadSource, concurrency: settings.downloadConcurrency })
    this.versionCache = { at: Date.now(), value }
    return value
  }

  async loaderVersions(kind: 'fabric' | 'quilt' | 'forge' | 'neoforge', minecraft: string): Promise<LoaderVersions> {
    const id = String(minecraft ?? '').trim()
    if (!id) throw new Error('先选一个 Minecraft 版本')
    const key = `${kind}|${id}`
    const cached = this.loaderCache.get(key)
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.value
    const settings = await this.store.load()
    const options = { source: settings.downloadSource, concurrency: settings.downloadConcurrency }
    const value = kind === 'fabric' ? await listFabricLoaders(id, options) : kind === 'quilt' ? await listQuiltLoaders(id, options) : kind === 'forge' ? await listForgeLoaders(id, options) : await listNeoForgeLoaders(id, options)
    this.loaderCache.set(key, { at: Date.now(), value })
    return value
  }

  async install(request: InstallRequest): Promise<string> {
    const folder = await this.knownFolder(request.folder)
    const kind = request.kind
    const minecraft = String(request.minecraft ?? '').trim()
    if (!minecraft) throw new Error('先选一个 Minecraft 版本')
    const settings = await this.store.load()
    if (kind === 'forge' || kind === 'neoforge') {
      const listing = await this.loaderVersions(kind, minecraft)
      const loader = request.loader?.trim() || listing.recommended
      if (!loader) throw new Error(listing.reason ?? `${minecraft} 没有 ${loaderLabel(kind)} 版本`)
      if (!listing.loaders.some((entry) => entry.version === loader)) throw new Error(`${minecraft} 没有 ${loaderLabel(kind)} ${loader}`)
      const name = request.name?.trim() || `${minecraft}-${loaderLabel(kind)} ${loader}`
      if (!validVersionId(name)) throw new Error('版本名不合法')
      const handle = this.tasks.start('install', `安装 ${name}`, `${folder}|${name}`)
      const options = {
        folder,
        minecraft,
        loader,
        name,
        isolated: true,
        source: settings.downloadSource,
        concurrency: settings.downloadConcurrency,
        installerJavaPaths: settings.extraJavaPaths,
        signal: handle.signal,
        onProgress: handle.progress
      }
      void (async () => {
        const result = kind === 'forge' ? await installForge(options) : await installNeoForge(options)
        await this.updateSettings({ selectedFolder: folder, selectedVersion: result.name })
        this.emit('instances-changed', folder)
        this.note(`${result.name} 安装完成：${result.downloaded} 个文件${result.processors ? `，运行 ${result.processors} 个安装处理器` : ''}${result.java ? `，安装器用 ${result.java}` : ''}`)
        handle.succeed(`已安装 ${result.name}${result.java ? `，安装器用 ${result.java}` : ''}`)
      })().catch((error: unknown) => this.failInstall(handle, error, folder, name))
      return handle.id
    }
    if (kind !== 'vanilla' && kind !== 'fabric' && kind !== 'quilt') throw new Error('这个加载器还不支持安装')
    const loader = kind === 'vanilla' ? null : request.loader?.trim() || (await this.loaderVersions(kind, minecraft)).recommended
    if (kind !== 'vanilla' && !loader) throw new Error(`${minecraft} 没有 ${loaderLabel(kind)} 版本`)
    const name = request.name?.trim() || (kind === 'vanilla' ? minecraft : `${minecraft}-${loaderLabel(kind)} ${loader}`)
    if (!validVersionId(name)) throw new Error('版本名不合法')
    const handle = this.tasks.start('install', `安装 ${name}`, `${folder}|${name}`)
    const options = {
      folder,
      name,
      version: minecraft,
      loader: loader ?? undefined,
      companions: request.companions,
      isolated: true,
      source: settings.downloadSource,
      concurrency: settings.downloadConcurrency,
      signal: handle.signal,
      onProgress: handle.progress
    }
    void (async () => {
      const result = kind === 'vanilla' ? await installVanilla(options) : kind === 'fabric' ? await installFabric(options) : await installQuilt(options)
      await this.updateSettings({ selectedFolder: folder, selectedVersion: result.name })
      this.emit('instances-changed', folder)
      this.note(`${result.name} 安装完成：${result.downloaded} 个文件${result.note ? `；${result.note}` : ''}`)
      handle.succeed(`已安装 ${result.name}`)
    })().catch((error: unknown) => this.failInstall(handle, error, folder, name))
    return handle.id
  }

  async repair(folder: string, versionId: string): Promise<string> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    if ((this.current.state === 'running' || this.current.state === 'starting') && this.current.versionId === versionId) throw new Error('游戏正在运行，先停止再修复')
    const settings = await this.store.load()
    const handle = this.tasks.start('repair', `修复 ${versionId}`, `${root}|${versionId}`)
    void repairInstance({
      folder: root,
      name: versionId,
      source: settings.downloadSource,
      concurrency: settings.downloadConcurrency,
      signal: handle.signal,
      onProgress: handle.progress
    })
      .then((result) => {
        this.emit('instances-changed', root)
        this.note(`${versionId} 修复完成：${result.repaired > 0 ? `补全 ${result.repaired} 个文件` : '文件完整'}`)
        handle.succeed(result.repaired > 0 ? `补全 ${result.repaired} 个文件` : '文件完整')
      })
      .catch((error: unknown) => handle.fail(error))
    return handle.id
  }

  pclSnapshot(): Promise<PclSnapshot> {
    return readPclSnapshot({ appData: this.appData, launcherDirs: this.pclLauncherDirs })
  }

  async importPcl(): Promise<LauncherSettings> {
    const snapshot = await this.pclSnapshot()
    const settings = await this.store.load()
    const folders = [...settings.folders]
    for (const folder of snapshot.folders) {
      if (!folders.some((item) => item.path.toLowerCase() === folder.path.toLowerCase())) folders.push(folder)
    }
    const imported = snapshot.accounts.map(accountFromPcl).filter((account): account is Account => !!account)
    const offlineName = snapshot.accounts.map((account) => account.username).find(validOfflineName)
    const hasOffline = [...settings.accounts, ...imported].some((account) => account.kind === 'offline')
    const accounts = mergeAccounts(mergeAccounts(settings.accounts, hasOffline || !offlineName ? [] : [offlineAccount(offlineName)]), imported)
    return this.updateSettings({
      folders,
      selectedFolder: settings.selectedFolder ?? snapshot.selectedFolder,
      selectedVersion: settings.selectedVersion ?? snapshot.selectedVersion,
      extraJavaPaths: [...new Set([...settings.extraJavaPaths, ...snapshot.javaPaths])],
      accounts,
      selectedAccountId: settings.selectedAccountId ?? accounts[0]?.id ?? null,
      importedFromPclAt: Date.now()
    })
  }

  async addOfflineAccount(name: string): Promise<LauncherSettings> {
    const account = offlineAccount(String(name ?? '').trim())
    const settings = await this.store.load()
    return this.updateSettings({ accounts: mergeAccounts(settings.accounts, [account]), selectedAccountId: account.id })
  }

  async removeAccount(id: string): Promise<LauncherSettings> {
    const settings = await this.store.load()
    const accounts = settings.accounts.filter((account) => account.id !== id)
    const index = settings.accounts.findIndex((account) => account.id === id)
    const selectedAccountId = settings.selectedAccountId === id ? (accounts[Math.min(Math.max(index, 0), accounts.length - 1)]?.id ?? null) : settings.selectedAccountId
    return this.updateSettings({ accounts, selectedAccountId })
  }

  async selectAccount(id: string): Promise<LauncherSettings> {
    const settings = await this.store.load()
    if (!settings.accounts.some((account) => account.id === id)) return settings
    return this.updateSettings({ selectedAccountId: id })
  }

  async skin(accountId: string): Promise<SkinInfo> {
    const settings = await this.store.load()
    const account = settings.accounts.find((item) => item.id === accountId)
    if (!account) return { dataUrl: null, slim: false }
    return this.skins.get(account)
  }

  private async knownFolder(folder: string): Promise<string> {
    const normalized = normalizeFolder(folder)
    const settings = await this.store.load()
    if (!settings.folders.some((item) => normalizeFolder(item.path).toLowerCase() === normalized.toLowerCase())) throw new Error('这个游戏目录不在列表里')
    return normalized
  }

  async instanceIcon(folder: string, versionId: string): Promise<string | null> {
    if (!validVersionId(versionId)) return null
    const root = await this.knownFolder(folder)
    return this.icons.get(root, versionId, await this.customIcons.customPath(root, versionId))
  }

  async folderPath(folder: string, versionId: string, target: FolderTarget): Promise<string> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    if (target === 'version') return join(root, 'versions', versionId)
    const instance = await readInstance(root, versionId)
    return target === 'game' ? instance.gameDir : join(instance.gameDir, target)
  }

  async javas(): Promise<JavaEntry[]> {
    if (!this.javaCache) {
      const settings = await this.store.load()
      this.javaCache = detectJava(settings.extraJavaPaths).catch((error) => {
        this.javaCache = null
        throw error
      })
    }
    return this.javaCache
  }

  private async javaFor(instance: InstanceInfo): Promise<string | undefined> {
    const list = await this.javas()
    const preferred = instance.preferredJava
    if (preferred && !list.some((java) => java.path.toLowerCase() === preferred.toLowerCase())) {
      list.push(...(await detectJava([preferred], false)))
    }
    return pickJava(list, instance.javaMajor, preferred)?.path
  }

  status(): LaunchStatus {
    return { ...this.current }
  }

  logs(): LogLine[] {
    return [...this.logLines]
  }

  private log(line: LogLine): void {
    this.logLines.push(line)
    if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT)
    this.emit('log', line)
  }

  private note(text: string): void {
    this.log({ at: Date.now(), stream: 'launcher', text })
  }

  private setStatus(patch: Partial<LaunchStatus>): void {
    this.current = { ...this.current, ...patch }
    this.emit('status', this.status())
  }

  private launchName(settings: LauncherSettings, accountId: string | undefined): string {
    const id = accountId ?? settings.selectedAccountId
    const account = settings.accounts.find((item) => item.id === id)
    if (!account) throw new Error('先添加或选择一个账号')
    if (account.kind !== 'offline') throw new Error(`${account.name} 需要重新登录后才能启动（正版与第三方登录还在开发）`)
    if (!validOfflineName(account.name)) throw new Error('离线用户名只能是 3–16 位字母、数字或下划线')
    return account.name
  }

  private async completeFiles(
    folder: string,
    versionId: string,
    settings: LauncherSettings,
    onProgress?: (progress: TaskProgress, detail: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const report = await quickCheck({ folder, name: versionId, signal })
    if (report.missing === 0) return
    this.note(`检查到 ${report.missing} 个文件缺失，正在补全`)
    const handle = this.tasks.start('repair', `补全 ${versionId} 的文件`, `${folder}|${versionId}`)
    const relay = (): void => this.tasks.cancel(handle.id)
    signal?.addEventListener('abort', relay, { once: true })
    let repaired = 0
    try {
      const result = await repairInstance({
        folder,
        name: versionId,
        source: settings.downloadSource,
        concurrency: settings.downloadConcurrency,
        signal: handle.signal,
        onProgress: (progress, detail) => {
          handle.progress(progress, detail)
          onProgress?.(progress, detail ?? '')
        }
      })
      repaired = result.repaired
      handle.succeed(repaired > 0 ? `补全 ${repaired} 个文件` : '文件完整')
    } catch (error) {
      handle.fail(error)
      throw new Error(`补全文件失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      signal?.removeEventListener('abort', relay)
    }
    this.note(`补全 ${repaired} 个缺失文件`)
    const after = await quickCheck({ folder, name: versionId, signal })
    if (after.missing > 0) throw new Error(`还有 ${after.missing} 个文件缺失，去版本页修复后再启动`)
    this.emit('instances-changed', folder)
  }

  private async effectiveLaunchSettings(
    settings: LauncherSettings,
    instance: InstanceInfo,
    override: InstanceOverride,
    pcl: Map<string, string>,
    javas: JavaEntry[]
  ): Promise<LaunchEffective> {
    const { effective, source } = resolveSettings(override, pcl, settings)
    let javaPath = effective.javaPath
    let javaSource: SettingSource = javaPath ? source.java : 'global'
    if (javaPath && !javas.some((java) => java.path.toLowerCase() === javaPath?.toLowerCase())) {
      const probed = await detectJava([javaPath], false).catch(() => [])
      javas.push(...probed)
      if (probed.length === 0) {
        javaPath = null
        javaSource = 'global'
      }
    }
    javaPath = javaPath ?? (await this.javaFor(instance)) ?? null
    return {
      javaPath,
      javaMajor: javas.find((java) => java.path === javaPath)?.majorVersion ?? instance.javaMajor,
      javaSource,
      maxMemoryMb: effective.maxMemoryMb,
      memorySource: source.memory,
      jvmArgs: effective.jvmArgs,
      jvmSource: override.jvmArgs ? 'instance' : effective.jvmArgs ? 'pcl' : 'global',
      gameArgs: effective.gameArgs,
      gameArgsSource: override.gameArgs ? 'instance' : effective.gameArgs ? 'pcl' : 'global',
      width: effective.windowWidth,
      height: effective.windowHeight,
      fullscreen: effective.fullscreen,
      windowSource: source.window
    }
  }

  private markStep(id: LaunchStepId, patch: Partial<Omit<LaunchStep, 'id' | 'label'>>): void {
    this.steps = updateLaunchStep(this.steps, id, patch)
    this.setStatus({ steps: this.steps })
  }

  async launch(request: LaunchRequest): Promise<LaunchStatus> {
    if (this.child && this.current.state === 'running') throw new Error('已有游戏在运行，先停止它')
    const settings = await this.store.load()
    const folder = normalizeFolder(request.folder)
    const instance = await readInstance(folder, request.versionId)
    if (instance.error && !instance.minecraftVersion) throw new Error(`版本无法启动：${instance.error}`)
    const override = await this.instanceSettings.get(folder, request.versionId)
    const pcl = await readPclVersionSetup(folder, request.versionId)
    const javas = await this.javas()
    const effective = await this.effectiveLaunchSettings(settings, instance, override, pcl, javas)
    const abort = new AbortController()
    this.launchAbort = abort
    this.runLines = []
    this.logLines.length = 0
    this.steps = initialLaunchSteps()
    this.setStatus({ ...IDLE, state: 'starting', versionId: request.versionId, steps: this.steps })
    let windowShown = false
    let finished = false
    try {
      const username = request.username ?? this.launchName(settings, request.accountId)
      this.markStep('account', { state: 'done', detail: `离线账号 ${username}` })
      const javaPath = request.javaPath ?? effective.javaPath
      if (!javaPath) throw new Error(`没有找到 Java ${instance.javaMajor ?? ''}，请在设置里添加`)
      this.markStep('java', { state: 'done', detail: javaPath })
      const gameDir = request.gameDir ?? instance.gameDir
      const maxMemoryMb = request.maxMemoryMb ?? effective.maxMemoryMb
      this.setStatus({ effective })
      this.note(`启动 ${request.versionId}（${instance.loader}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}，MC ${instance.minecraftVersion ?? '?'}）`)
      this.note(`Java：${javaPath}（${SETTING_SOURCE_LABEL[request.javaPath ? 'global' : effective.javaSource]}）`)
      this.note(`内存：${maxMemoryMb} MB（${SETTING_SOURCE_LABEL[request.maxMemoryMb ? 'global' : effective.memorySource]}）`)
      if (effective.jvmArgs) this.note(`JVM 参数：${effective.jvmArgs}（${SETTING_SOURCE_LABEL[effective.jvmSource]}）`)
      this.note(`游戏目录：${gameDir}${instance.isolated ? '（版本隔离）' : ''}`)
      if (request.ignoreWarnings) this.note('已确认启动前检查的提醒，继续启动')
      const report = await preflightLaunch({
        versionId: request.versionId,
        loader: instance.loader,
        instance,
        javas,
        javaPath,
        accountName: username,
        maxMemoryMb,
        totalMemMb: Math.round(totalmem() / 1024 / 1024),
        modsDir: join(gameDir, 'mods'),
        missingFiles: null
      })
      const blockers = report.items.filter((item) => item.level === 'block')
      if (blockers.length > 0) throw new Error(blockers.map((item) => `${item.title}${item.detail ? `：${item.detail}` : ''}`).join('；'))
      this.markStep('files', { state: 'running', detail: '检查文件是否齐全' })
      await this.completeFiles(
        folder,
        request.versionId,
        settings,
        (progress, detail) => this.markStep('files', { state: 'running', detail: detail || '补全文件', progress }),
        abort.signal
      )
      this.markStep('files', { state: 'done', detail: '文件完整' })
      const context = await this.crash.begin({ folder, versionId: request.versionId, loader: instance.loader, gameDir, javaPath, maxMemoryMb })
      const autoServer = override.autoEnter === false ? null : resolveSettings(override, pcl, settings).effective.server
      const launchOptions = {
        folder,
        versionId: request.versionId,
        username,
        javaPath,
        gameDir,
        maxMemoryMb,
        nativeRoot: join(this.dataDir, 'natives'),
        jvmArgs: effective.jvmArgs,
        gameArgs: this.gameArgsWithServer(effective.gameArgs, autoServer, instance.minecraftVersion),
        resolution: { width: effective.width ?? undefined, height: effective.height ?? undefined, fullscreen: effective.fullscreen }
      }
      const launchArgs = await describeLaunchCommand(launchOptions).catch(() => [])
      this.markStep('process', { state: 'running', detail: `启动 ${instance.minecraftVersion ?? request.versionId}` })
      const child = await launchOffline(
        launchOptions,
        {
          log: (line) => {
            this.runLines.push(line)
            if (this.runLines.length > LOG_LIMIT) this.runLines.shift()
            this.log(line)
            if (windowShown || finished || line.stream === 'launcher' || !isStartupFatal(instance.loader, line.text)) return
            setTimeout(() => {
              if (windowShown || finished || !this.child) return
              finished = true
              this.note('启动期报错，游戏卡在加载器错误窗口，正在停止进程')
              this.child?.kill()
              void this.finishRun(context, {
                exitCode: null,
                crashReport: null,
                windowShown: false,
                launchArgs,
                stopped: false,
                message: '游戏窗口出现前就报错，已停止卡住的进程'
              })
            }, STARTUP_FATAL_DELAY_MS)
          },
          windowReady: () => {
            windowShown = true
            this.markStep('window', { state: 'done', detail: '游戏窗口已出现' })
            this.note('游戏窗口已出现')
          },
          error: (message) => {
            this.note(`启动失败：${message}`)
            if (finished) return
            finished = true
            void this.finishRun(context, { exitCode: null, crashReport: null, windowShown, launchArgs, stopped: abort.signal.aborted, message })
          },
          exit: (code, crashReport) => {
            this.note(`游戏已退出（code=${code ?? 'null'}）`)
            if (finished) return
            finished = true
            void this.finishRun(context, { exitCode: code, crashReport, windowShown, launchArgs, stopped: abort.signal.aborted, message: null })
          }
        }
      )
      this.child = child
      this.markStep('process', { state: 'done', detail: `进程已启动（PID ${child.pid ?? '?'}）` })
      this.markStep('window', { state: 'running', detail: '等待游戏窗口' })
      this.setStatus({ state: 'running', pid: child.pid ?? null, javaPath, runningSince: Date.now() })
      return this.status()
    } catch (error) {
      const cancelled = abort.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      this.launchAbort = null
      this.steps = this.steps.map((step) => (step.state === 'running' ? { ...step, state: cancelled ? 'skipped' : 'failed' } : step.state === 'pending' ? { ...step, state: 'skipped' } : step))
      this.note(cancelled ? '已取消启动' : `启动失败：${message}`)
      this.setStatus({ state: cancelled ? 'exited' : 'failed', error: cancelled ? '已取消启动' : message, steps: this.steps })
      return this.status()
    }
  }

  private async finishRun(
    context: CrashRunContext,
    result: { exitCode: number | null; crashReport: string | null; windowShown: boolean; launchArgs: string[]; stopped: boolean; message: string | null }
  ): Promise<void> {
    this.child = null
    this.launchAbort = null
    const settings = await this.store.load()
    const instance = await readInstance(context.options.folder, context.options.versionId).catch(() => null)
    const javas = await this.javas().catch(() => [])
    const analysis = await this.crash
      .finish(context, {
        exitCode: result.exitCode,
        windowShown: result.windowShown,
        processLines: this.runLines.filter((line) => line.stream !== 'launcher').map((line) => line.text),
        launchArgs: result.launchArgs,
        stopped: result.stopped,
        actions: ({ result: diagnosed, bundle }) =>
          buildCrashActions({
            rule: diagnosed.rule,
            suspects: diagnosed.suspects,
            missing: diagnosed.outcome?.missing ?? [],
            names: modNames(bundle.mods),
            javas,
            javaPath: context.options.javaPath,
            requiredMajor: instance?.javaMajor ?? null,
            maxMemoryMb: settings.maxMemoryMb,
            totalMemMb: Math.round(totalmem() / 1024 / 1024)
          })
      })
      .catch(() => null)
    if (!result.windowShown && !result.stopped) this.markStep('window', { state: 'failed', detail: '窗口没出现就退出了' })
    const failed = (result.exitCode !== null && result.exitCode !== 0) || !result.windowShown
    this.setStatus({
      state: failed && !result.stopped ? 'failed' : 'exited',
      exitCode: normalizeExitCode(result.exitCode),
      crashReport: result.crashReport,
      error: result.message,
      pid: null,
      runningSince: null,
      crashId: analysis?.diagnosis.id ?? null
    })
    if (analysis) {
      this.note(`崩溃已收集：${analysis.diagnosis.rule?.title ?? '没认出原因'}`)
      this.emit('crash', analysis.diagnosis)
    }
  }

  async preflight(request: PreflightRequest): Promise<PreflightReport> {
    const folder = await this.knownFolder(request.folder)
    const settings = await this.store.load()
    const instance = await readInstance(folder, request.versionId)
    let missingFiles: number | null = null
    try {
      missingFiles = (await quickCheck({ folder, name: request.versionId })).missing
    } catch {
      missingFiles = null
    }
    const override = await this.instanceSettings.get(folder, request.versionId)
    const pcl = await readPclVersionSetup(folder, request.versionId)
    const javas = await this.javas()
    const effective = await this.effectiveLaunchSettings(settings, instance, override, pcl, javas)
    return preflightLaunch({
      versionId: request.versionId,
      loader: instance.loader,
      instance,
      javas,
      javaPath: request.javaPath ?? effective.javaPath,
      accountName: settings.accounts.find((account) => account.id === settings.selectedAccountId)?.name ?? null,
      maxMemoryMb: request.maxMemoryMb ?? effective.maxMemoryMb,
      totalMemMb: Math.round(totalmem() / 1024 / 1024),
      modsDir: join(instance.gameDir, 'mods'),
      missingFiles
    })
  }

  async setLaunchJava(folder: string, versionId: string, javaPath: string | null): Promise<void> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    if (!javaPath) {
      await this.instanceSettings.patch(root, versionId, { javaPath: null })
      return
    }
    const entry = (await this.javas()).find((java) => java.path.toLowerCase() === javaPath.toLowerCase())
    if (!entry) throw new Error('这个 Java 不在列表里，先在设置里添加')
    await this.instanceSettings.patch(root, versionId, { javaPath: entry.path })
    this.note(`单版本设置里给 ${versionId} 指定了 Java：${entry.path}`)
  }

  crashLatest(folder: string, versionId: string): Promise<CrashDiagnosis | null> {
    return this.crash.latest(normalizeFolder(folder), versionId)
  }

  crashList(folder: string, versionId: string): Promise<CrashRecordSummary[]> {
    return this.crash.list(normalizeFolder(folder), versionId)
  }

  async crashExport(folder: string, versionId: string, id: string): Promise<CrashExportResult | null> {
    const handle = this.tasks.start('export', `导出崩溃报告 ${versionId}`)
    try {
      const result = await this.crash.exportRecord(normalizeFolder(folder), versionId, id)
      if (!result) {
        handle.fail(new Error('找不到这份崩溃记录'))
        return null
      }
      handle.succeed(`已导出 ${Math.max(1, Math.round(result.bytes / 1024))} KB`)
      this.note(`诊断包已导出：${result.path}`)
      return result
    } catch (error) {
      handle.fail(error)
      throw error
    }
  }

  async crashAction(request: CrashActionRequest): Promise<CrashActionResult> {
    const folder = await this.knownFolder(request.folder)
    if (!validVersionId(request.versionId)) return { ok: false, message: '版本名不合法' }
    const diagnosis = await this.crash.get(folder, request.versionId, request.diagnosisId)
    const instance = await readInstance(folder, request.versionId)
    const modsDir = join(instance.gameDir, 'mods')
    const value = request.value ?? null
    if (request.kind === 'install-deps') {
      const modIds = (diagnosis?.missing.length ? diagnosis.missing : (value ?? '').split(',')).map((id) => id.trim()).filter(Boolean)
      if (modIds.length === 0) return { ok: false, message: '没有找到要补全的 modid' }
      const handle = this.tasks.start('mod-install', `补全依赖（${modIds.join('、')}）`)
      try {
        const listed = await this.mods.list(await this.instanceContext(folder, request.versionId))
        const ranges: Record<string, string[]> = {}
        const requiredBy: Record<string, string[]> = {}
        for (const need of collectDependencyNeeds(listed.mods, modIds)) {
          ranges[need.modId] = need.ranges
          requiredBy[need.modId] = need.requiredBy
        }
        const result = await installMissingDependencies({
          modsDir,
          minecraftVersion: instance.minecraftVersion,
          loader: instance.loader,
          modIds,
          ranges,
          requiredBy,
          signal: handle.signal,
          onProgress: handle.progress
        })
        if (result.installed.length === 0) {
          const reason = result.failed[0]?.reason ?? '没有下载到任何文件'
          handle.fail(new Error(reason))
          return { ok: false, message: reason }
        }
        handle.succeed(`补全 ${result.installed.length} 个文件`)
        this.emit('instances-changed', folder)
        const failed = result.failed.map((item) => `${item.modId}：${item.reason}`).join('；')
        return { ok: true, message: `已补全 ${result.installed.join('、')}${failed ? `；未完成 ${failed}` : ''}` }
      } catch (error) {
        handle.fail(error)
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (request.kind === 'disable-mod') {
      const fileName = value ?? diagnosis?.suspects[0]?.fileName ?? ''
      if (!fileName || /[\\/]/.test(fileName)) return { ok: false, message: '没有要停用的 Mod' }
      const from = join(modsDir, fileName)
      if (!existsSync(from)) return { ok: false, message: `${fileName} 不在 mods 目录里` }
      await rename(from, `${from}.disabled`)
      this.emit('instances-changed', folder)
      return { ok: true, message: `已停用 ${fileName}（改回 .jar 就恢复）` }
    }
    if (request.kind === 'java') {
      if (!value) return { ok: false, message: '没有可换的 Java' }
      await this.setLaunchJava(folder, request.versionId, value)
      return { ok: true, message: `之后启动用 ${value}` }
    }
    if (request.kind === 'memory') {
      const mb = Number(value)
      if (!Number.isFinite(mb) || mb < 512) return { ok: false, message: '内存值不合法' }
      await this.updateSettings({ maxMemoryMb: Math.round(mb) })
      return { ok: true, message: `内存上限改成 ${Math.round(mb)} MB` }
    }
    return { ok: false, message: '这个动作在界面上处理' }
  }

  private async instanceContext(folder: string, versionId: string): Promise<InstanceContext> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    const instance = await readInstance(root, versionId)
    return { folder: root, versionId, gameDir: instance.gameDir, loader: instance.loader, minecraftVersion: instance.minecraftVersion }
  }

  async modList(folder: string, versionId: string): Promise<ModListResult> {
    return this.mods.list(await this.instanceContext(folder, versionId))
  }

  async modToggle(folder: string, versionId: string, file: string, enabled: boolean): Promise<ModListResult> {
    const ctx = await this.instanceContext(folder, versionId)
    const result = await this.mods.toggle(ctx, String(file ?? ''), enabled === true)
    this.emit('instances-changed', ctx.folder)
    return result
  }

  async modRemove(folder: string, versionId: string, file: string): Promise<ModListResult> {
    const ctx = await this.instanceContext(folder, versionId)
    const result = await this.mods.remove(ctx, String(file ?? ''))
    this.emit('instances-changed', ctx.folder)
    return result
  }

  async modRestore(folder: string, versionId: string, id: string): Promise<ModListResult> {
    const ctx = await this.instanceContext(folder, versionId)
    const result = await this.mods.restore(ctx, String(id ?? ''))
    this.emit('instances-changed', ctx.folder)
    return result
  }

  async modToggleMany(folder: string, versionId: string, files: string[], enabled: boolean): Promise<ModBatchResult> {
    const ctx = await this.instanceContext(folder, versionId)
    const result = await this.mods.toggleMany(ctx, files, enabled === true)
    this.emit('instances-changed', ctx.folder)
    return result
  }

  async modRemoveMany(folder: string, versionId: string, files: string[]): Promise<ModBatchResult> {
    const ctx = await this.instanceContext(folder, versionId)
    const result = await this.mods.removeMany(ctx, files)
    this.emit('instances-changed', ctx.folder)
    return result
  }

  async modInstallDeps(folder: string, versionId: string, modIds: string[]): Promise<string> {
    const ctx = await this.instanceContext(folder, versionId)
    const handle = this.tasks.start('mod-install', `补全 ${ctx.versionId} 的依赖`, `${ctx.folder}|${ctx.versionId}`)
    void this.mods
      .installDependencies(ctx, modIds.filter((id) => typeof id === 'string'), { signal: handle.signal, onProgress: handle.progress })
      .then((outcome) => {
        this.emit('instances-changed', ctx.folder)
        const installed = [...outcome.installed, ...outcome.skipped]
        const failed = outcome.failed.map((item) => `${item.modId}：${item.reason}`).join('；')
        if (installed.length === 0) {
          handle.fail(new Error(failed || '没有下载到任何文件'))
          return
        }
        this.note(`补全 ${installed.length} 个依赖文件`)
        handle.succeed(`补全 ${installed.length} 个文件${failed ? `；没装成 ${failed}` : ''}`)
      })
      .catch((error: unknown) => handle.fail(error))
    return handle.id
  }

  async modCheckUpdates(folder: string, versionId: string): Promise<ModUpdateCheckResult> {
    return this.mods.checkUpdates(await this.instanceContext(folder, versionId))
  }

  modSearch(query: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    return this.mods.search(query)
  }

  modVersions(projectId: string, loader: string | null, minecraft: string | null): Promise<ModrinthVersion[]> {
    return this.mods.versions(String(projectId ?? ''), { loader, minecraft })
  }

  modProject(projectId: string): Promise<ModrinthProject | null> {
    return this.mods.project(String(projectId ?? ''))
  }

  async modAddFiles(folder: string, versionId: string, paths: string[]): Promise<string[]> {
    const ctx = await this.instanceContext(folder, versionId)
    const copied = await this.mods.addFiles(ctx, paths.filter((path): path is string => typeof path === 'string'))
    if (copied.length > 0) this.emit('instances-changed', ctx.folder)
    return copied
  }

  async modInstall(request: ModInstallRequest): Promise<string> {
    const ctx = await this.instanceContext(request.folder, request.versionId)
    const handle = this.tasks.start('mod-install', `安装 Mod 到 ${ctx.versionId}`, `${ctx.folder}|${ctx.versionId}`)
    void this.mods
      .install(ctx, String(request.versionFileId ?? ''), { signal: handle.signal, onProgress: handle.progress })
      .then((result) => {
        const count = result.installed.length
        const deps = result.dependencies.length
        this.note(`已安装 ${count} 个 Mod${deps > 0 ? `（含 ${deps} 个前置）` : ''}`)
        this.emit('instances-changed', ctx.folder)
        handle.succeed(count > 0 ? `已安装 ${count} 个文件${deps > 0 ? `，其中 ${deps} 个前置` : ''}` : '已经装过了')
      })
      .catch((error: unknown) => handle.fail(error))
    return handle.id
  }

  async modUpdate(request: ModUpdateRequest): Promise<string> {
    const ctx = await this.instanceContext(request.folder, request.versionId)
    const handle = this.tasks.start('mod-update', `更新 ${ctx.versionId} 的 Mod`, `${ctx.folder}|${ctx.versionId}`)
    void this.mods
      .update(ctx, Array.isArray(request.updates) ? request.updates : [], { signal: handle.signal, onProgress: handle.progress })
      .then((result) => {
        this.note(`更新了 ${result.updated.length} 个 Mod，旧文件在 .trash 里`)
        this.emit('instances-changed', ctx.folder)
        handle.succeed(result.updated.length > 0 ? `更新了 ${result.updated.length} 个 Mod` : '没有可更新的 Mod')
      })
      .catch((error: unknown) => handle.fail(error))
    return handle.id
  }

  async instanceOverview(folder: string, versionId: string): Promise<InstanceOverview> {
    const ctx = await this.instanceContext(folder, versionId)
    const instance = await readInstance(ctx.folder, versionId)
    const settings = await this.store.load()
    const override = await this.instanceSettings.get(ctx.folder, versionId)
    const pcl = await readPclVersionSetup(ctx.folder, versionId)
    const versionDir = join(ctx.folder, 'versions', versionId)
    const mods = await this.mods.list(ctx)
    const missingDeps = mods.mods.flatMap((mod) => mod.issues.filter((issue) => issue.kind === 'missing-dependency').map((issue) => issue.modId ?? issue.text))
    const list = await this.javas()
    const wanted = override.javaPath ?? instance.preferredJava
    const javaAvailable = !!pickJava(list, instance.javaMajor, wanted ?? undefined)
    const report = await quickCheck({ folder: ctx.folder, name: versionId }).catch(() => ({ missing: 0 }))
    return buildOverview({
      instance,
      settings,
      override,
      pcl,
      sizeBytes: await directorySize(versionDir),
      lastPlayedAt: await lastPlayedAt(instance, versionDir),
      modTotal: mods.counts.total,
      modIssues: mods.counts.issues,
      missingDeps,
      javaAvailable,
      missingFiles: report.missing
    })
  }

  async updateInstanceSettings(folder: string, versionId: string, patch: Partial<InstanceOverride>): Promise<InstanceOverride> {
    const ctx = await this.instanceContext(folder, versionId)
    return this.instanceSettings.patch(ctx.folder, versionId, patch)
  }

  private ensureInstanceIdle(versionId: string): void {
    if ((this.current.state === 'running' || this.current.state === 'starting') && this.current.versionId === versionId) {
      throw new Error('游戏正在运行，先停止再做这个操作')
    }
  }

  private async moveInstanceOverride(root: string, from: string, to: string): Promise<void> {
    const override = await this.instanceSettings.get(root, from)
    await this.instanceSettings.patch(root, to, override)
    await this.instanceSettings.patch(root, from, EMPTY_OVERRIDE)
    const icon = await this.customIcons.customPath(root, from)
    if (!icon) return
    const png = await readFile(icon).catch(() => null)
    if (png) await this.customIcons.set(root, to, png)
    await this.customIcons.clear(root, from)
  }

  async renameInstance(folder: string, versionId: string, nextId: string): Promise<{ id: string; jarRenamed: boolean }> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    this.ensureInstanceIdle(versionId)
    const result = await renameVersionDir(root, versionId, String(nextId ?? ''))
    await this.moveInstanceOverride(root, versionId, result.id)
    const settings = await this.store.load()
    if (settings.selectedVersion === versionId) await this.updateSettings({ selectedVersion: result.id })
    this.emit('instances-changed', root)
    this.note(`${versionId} 改名为 ${result.id}${result.jarRenamed ? '（文件夹、json 与 jar 一起改了）' : '（文件夹与 json 一起改了）'}`)
    return { id: result.id, jarRenamed: result.jarRenamed }
  }

  async copyInstance(folder: string, versionId: string, name: string | null): Promise<CopyInstanceResult> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    this.ensureInstanceIdle(versionId)
    const result = await copyVersionDir(root, versionId, name ?? undefined)
    await this.instanceSettings.patch(root, result.id, await this.instanceSettings.get(root, versionId))
    this.emit('instances-changed', root)
    this.note(`已复制 ${versionId} 为 ${result.id}`)
    return result
  }

  async deleteInstance(folder: string, versionId: string): Promise<InstanceTrashRecord> {
    if (!validVersionId(versionId)) throw new Error('版本名不合法')
    const root = await this.knownFolder(folder)
    this.ensureInstanceIdle(versionId)
    const record = await trashVersionDir(root, versionId)
    await this.instanceSettings.patch(root, versionId, EMPTY_OVERRIDE)
    const settings = await this.store.load()
    if (settings.selectedVersion === versionId) {
      const rest = (await listInstances(root)).filter((item) => item.id !== versionId)
      await this.updateSettings({ selectedVersion: rest[0]?.id ?? null })
    }
    this.emit('instances-changed', root)
    this.note(`${versionId} 已移到 .trash/instances，可以在版本回收站里恢复`)
    return record
  }

  async trashedInstances(folder: string): Promise<InstanceTrashRecord[]> {
    return listTrashedInstances(await this.knownFolder(folder))
  }

  async restoreInstance(folder: string, trashId: string): Promise<string> {
    const root = await this.knownFolder(folder)
    const versionId = await restoreTrashedInstance(root, String(trashId ?? ''))
    this.emit('instances-changed', root)
    this.note(`${versionId} 已从回收站恢复`)
    return versionId
  }

  async versionResources(folder: string, versionId: string): Promise<VersionResources> {
    return readResources((await this.instanceContext(folder, versionId)).gameDir)
  }

  async versionScreenshots(folder: string, versionId: string): Promise<ScreenshotEntry[]> {
    return listScreenshots((await this.instanceContext(folder, versionId)).gameDir)
  }

  async resourceToggle(folder: string, versionId: string, file: string, enabled: boolean): Promise<VersionResources> {
    const ctx = await this.instanceContext(folder, versionId)
    await toggleResourcePack(ctx.gameDir, String(file ?? ''), enabled === true)
    this.note(`资源包 ${file} ${enabled ? '已启用' : '已停用'}`)
    return readResources(ctx.gameDir)
  }

  async resourceDelete(folder: string, versionId: string, kind: ResourceKind, file: string): Promise<VersionResources> {
    const ctx = await this.instanceContext(folder, versionId)
    if (kind !== 'resourcepacks' && kind !== 'shaderpacks' && kind !== 'saves') throw new Error('不支持的资源类型')
    await trashResource(ctx.gameDir, kind, String(file ?? ''))
    this.note(`${file} 已移到 .trash/${kind}`)
    return readResources(ctx.gameDir)
  }

  async instanceIconOptions(folder: string, versionId: string): Promise<InstanceIconOption[]> {
    return readIconOptions((await this.instanceContext(folder, versionId)).gameDir)
  }

  async setInstanceIcon(folder: string, versionId: string, kind: string, ref: string | null): Promise<string | null> {
    const ctx = await this.instanceContext(folder, versionId)
    const png = kind === 'file' ? await readFile(String(ref ?? '')).catch(() => null) : await readIconOption(ctx.gameDir, kind as InstanceIconKind, String(ref ?? ''))
    if (!png) throw new Error('这个来源里没有可用的 PNG 图标')
    await this.customIcons.set(ctx.folder, versionId, png)
    this.note(`已更换 ${versionId} 的图标`)
    return this.icons.get(ctx.folder, versionId, await this.customIcons.customPath(ctx.folder, versionId))
  }

  async clearInstanceIcon(folder: string, versionId: string): Promise<void> {
    const ctx = await this.instanceContext(folder, versionId)
    await this.customIcons.clear(ctx.folder, versionId)
    this.note(`已清除 ${versionId} 的自定义图标`)
  }

  crashGet(folder: string, versionId: string, id: string): Promise<CrashDiagnosis | null> {
    return this.crash.get(normalizeFolder(folder), versionId, String(id ?? ''))
  }

  private gameArgsWithServer(base: string, server: string | null, minecraftVersion: string | null): string {
    const extra = serverArgs(minecraftVersion, server)
    if (extra.length === 0) return base
    if (/--server\b|--quickPlayMultiplayer\b/.test(base)) return base
    this.note(`启动后自动进入服务器：${normalizeServerAddress(server) ?? server}（${extra.join(' ')}）`)
    return [base, ...extra].filter(Boolean).join(' ')
  }

  async stop(): Promise<LaunchStatus> {
    if (this.launchAbort && !this.launchAbort.signal.aborted) this.launchAbort.abort()
    const child = this.child
    if (!child || child.exitCode !== null) return this.status()
    this.note('正在停止游戏')
    child.kill()
    return this.status()
  }

  private async failInstall(handle: TaskHandle, error: unknown, folder: string, name: string): Promise<void> {
    if (handle.signal.aborted) {
      const report = await cleanupCancelledInstall({ folder, name }).catch(() => null)
      const cleaned = report?.cleaned ?? 0
      this.tasks.detail(handle.id, `已取消，已清理 ${cleaned} 个临时文件`)
      this.note(`安装已取消，已清理 ${cleaned} 个临时文件`)
    }
    handle.fail(error)
  }

  downloadCategories(projectType: string): Promise<ContentCategory[]> {
    return this.community.categories(projectTypeOf(projectType))
  }

  downloadSearch(query: ContentSearchQuery): Promise<ModrinthSearchResult> {
    return this.community.search(query)
  }

  downloadVersions(projectId: string, loader: string | null, minecraft: string | null): Promise<ModrinthVersion[]> {
    return this.community.versions(String(projectId ?? ''), { loader, minecraft })
  }

  async downloadInstall(request: ContentInstallRequest): Promise<string> {
    const ctx = await this.instanceContext(request.folder, request.versionId)
    const type = installTypeOf(request.projectType)
    const dir = join(ctx.gameDir, type === 'shader' ? 'shaderpacks' : 'resourcepacks')
    const label = type === 'shader' ? '光影' : '资源包'
    const handle = this.tasks.start('mod-install', `安装${label}到 ${ctx.versionId}`, `${ctx.folder}|${ctx.versionId}`)
    void this.community
      .installTo(dir, String(request.versionFileId ?? ''), { signal: handle.signal, onProgress: handle.progress })
      .then((result) => {
        this.emit('instances-changed', ctx.folder)
        this.note(`${label}${result.skipped ? '已存在' : '已安装'}：${result.file}`)
        handle.succeed(result.skipped ? `已经有 ${result.file}` : `已安装 ${result.file}`)
      })
      .catch((error: unknown) => handle.fail(error))
    return handle.id
  }

  inspectModpack(path: string): Promise<ModpackSummary> {
    return inspectModpack(String(path ?? ''))
  }

  async importModpack(request: ModpackInstallRequest): Promise<string> {
    const folder = await this.knownFolder(request.folder)
    const path = String(request.path ?? '').trim()
    if (!path) throw new Error('先选一个 .mrpack 文件')
    const settings = await this.store.load()
    const summary = await inspectModpack(path)
    const name = sanitizeVersionName(request.name?.trim() || defaultModpackName(path, summary))
    if (!validVersionId(name)) throw new Error('版本名不合法')
    const handle = this.tasks.start('install', `导入整合包 ${name}`, `${folder}|${name}`)
    void importModpackFile({
      folder,
      path,
      name,
      isolated: true,
      source: settings.downloadSource,
      concurrency: settings.downloadConcurrency,
      installerJavaPaths: settings.extraJavaPaths,
      signal: handle.signal,
      onProgress: handle.progress
    })
      .then(async (result) => {
        await this.updateSettings({ selectedFolder: folder, selectedVersion: result.name })
        this.emit('instances-changed', folder)
        this.note(`${result.name} 导入完成：MC ${result.minecraft} ${result.loader} ${result.loaderVersion ?? ''}，${result.downloaded} 个文件，${result.overrides} 个覆盖文件`)
        handle.succeed(`已导入 ${result.name}`)
      })
      .catch((error: unknown) => this.failInstall(handle, error, folder, name))
    return handle.id
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
    this.tasks.removeAllListeners()
    this.removeAllListeners()
  }
}
