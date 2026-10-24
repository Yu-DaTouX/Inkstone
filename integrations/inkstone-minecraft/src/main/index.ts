import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import type { DownloadProbe, FolderTarget, InstallRequest, LauncherSettings, LaunchRequest, LaunchStatus, LogLine, TaskInfo } from '../shared/api.ts'
import type { CrashActionRequest, CrashDiagnosis } from '../shared/crash-api.ts'
import type { PreflightRequest } from '../shared/launch-api.ts'
import type { ResourceKind } from '../shared/version-api.ts'

const FOLDER_TARGETS: readonly FolderTarget[] = ['version', 'game', 'mods', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'logs', 'crash-reports']
import { CRAFT_CHANNELS } from '../shared/channels.ts'
import { MANIFEST_URL, MIRROR_ORIGIN, USER_AGENT } from '../core/download/sources.ts'
import { CraftService } from '../core/service.ts'
import { DevService } from '../core/dev/service.ts'
import { DEV_CHANNELS, type CreateFabricProjectRequest, type CompanionOwner, type DevLaunchOptions, type FabricVersionSet, type MappingFlavor } from '../shared/dev-api.ts'
import type { InstanceOverride, ModrinthSearchQuery, ModUpdateInfo } from '../shared/mods-api.ts'
import type { ContentSearchQuery } from '../shared/download-api.ts'

const service = new CraftService({
  pclLauncherDirs: (process.env.INKSTONE_MC_PCL_DIRS ?? '').split(';').filter(Boolean)
})

const dev = new DevService({
  dataDir: service.dataDir,
  javaPaths: async () => (await service.settings()).extraJavaPaths,
  maxMemoryMb: async () => (await service.settings()).maxMemoryMb
})

let window: BrowserWindow | null = null

const TITLE_BAR_HEIGHT = 40

const PROBE_TARGETS: { source: DownloadProbe['source']; label: string; url: string }[] = [
  { source: 'bmclapi', label: 'BMCLAPI', url: `${MIRROR_ORIGIN}/mc/game/version_manifest_v2.json` },
  { source: 'official', label: '官方', url: MANIFEST_URL }
]

async function probeDownloadSources(): Promise<DownloadProbe[]> {
  return Promise.all(
    PROBE_TARGETS.map(async (target) => {
      const startedAt = Date.now()
      try {
        const response = await fetch(target.url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': USER_AGENT } })
        if (!response.ok) return { source: target.source, label: target.label, ms: null, bytes: 0, error: `HTTP ${response.status}` }
        const bytes = (await response.arrayBuffer()).byteLength
        return { source: target.source, label: target.label, ms: Date.now() - startedAt, bytes, error: null }
      } catch (error) {
        return { source: target.source, label: target.label, ms: null, bytes: 0, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}

function titleBarColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: dark ? '#101010' : '#FAFAF9', symbolColor: dark ? '#F0EFEC' : '#0B0B0B', height: TITLE_BAR_HEIGHT }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    title: 'Inkstone Minecraft',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151515' : '#FCFCFB',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}

function applyTheme(settings: LauncherSettings): LauncherSettings {
  if (nativeTheme.themeSource !== settings.theme) nativeTheme.themeSource = settings.theme
  return settings
}

function broadcast(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function registerIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.settings, () => service.settings())
  ipcMain.handle(CRAFT_CHANNELS.updateSettings, async (_event, patch: Partial<LauncherSettings>) => applyTheme(await service.updateSettings(patch ?? {})))
  ipcMain.handle(CRAFT_CHANNELS.instances, (_event, folder: string) => service.instances(String(folder ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.installVersions, () => service.minecraftVersions())
  ipcMain.handle(CRAFT_CHANNELS.installLoaders, (_event, kind: unknown, minecraft: unknown) => {
    if (kind !== 'fabric' && kind !== 'quilt' && kind !== 'forge' && kind !== 'neoforge') throw new Error('不支持的加载器')
    return service.loaderVersions(kind, requiredText(minecraft, ' Minecraft 版本'))
  })
  ipcMain.handle(CRAFT_CHANNELS.installStart, (_event, request: unknown) => service.install(installRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.repair, (_event, folder: unknown, versionId: unknown) => service.repair(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  service.on('instances-changed', (folder: string) => broadcast(CRAFT_CHANNELS.instancesChanged, folder))
  ipcMain.handle(CRAFT_CHANNELS.javas, () => service.javas())
  ipcMain.handle(CRAFT_CHANNELS.pickJava, async () => {
    const options = {
      title: '选择 Java 可执行文件',
      properties: ['openFile' as const],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : undefined
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.probeDownloadSources, probeDownloadSources)
  ipcMain.handle(CRAFT_CHANNELS.pclSnapshot, () => service.pclSnapshot())
  ipcMain.handle(CRAFT_CHANNELS.importPcl, () => service.importPcl())
  ipcMain.handle(CRAFT_CHANNELS.addOfflineAccount, (_event, name: string) => service.addOfflineAccount(String(name ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.removeAccount, (_event, id: string) => service.removeAccount(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.selectAccount, (_event, id: string) => service.selectAccount(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.skin, (_event, id: string) => service.skin(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.instanceIcon, (_event, folder: string, versionId: string) => service.instanceIcon(String(folder ?? ''), String(versionId ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.openFolder, async (_event, folder: string, versionId: string, target: FolderTarget) => {
    if (!FOLDER_TARGETS.includes(target)) throw new Error('不支持的目录')
    const path = await service.folderPath(String(folder ?? ''), String(versionId ?? ''), target)
    if (!existsSync(path)) return null
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return path
  })
  ipcMain.handle(CRAFT_CHANNELS.tasks, () => service.tasks.list())
  ipcMain.handle(CRAFT_CHANNELS.cancelTask, (_event, id: string) => service.tasks.cancel(String(id ?? '')))
  ipcMain.handle(CRAFT_CHANNELS.clearFinishedTasks, () => service.tasks.clearFinished())
  service.tasks.on('task', (task: TaskInfo) => broadcast(CRAFT_CHANNELS.taskEvent, task))
  ipcMain.handle(CRAFT_CHANNELS.pickFolder, async () => {
    const options = { title: '选择 .minecraft 游戏目录', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.launch, (_event, request: LaunchRequest) => service.launch(request))
  ipcMain.handle(CRAFT_CHANNELS.stop, () => service.stop())
  ipcMain.handle(CRAFT_CHANNELS.status, () => service.status())
  ipcMain.handle(CRAFT_CHANNELS.logs, () => service.logs())
  service.on('log', (line: LogLine) => broadcast(CRAFT_CHANNELS.logEvent, line))
  service.on('status', (status: LaunchStatus) => broadcast(CRAFT_CHANNELS.statusEvent, status))
  ipcMain.handle(CRAFT_CHANNELS.preflight, (_event, request: unknown) => service.preflight(preflightRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.launchJava, (_event, folder: unknown, versionId: unknown, javaPath: unknown) =>
    service.setLaunchJava(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), typeof javaPath === 'string' && javaPath.trim() ? javaPath.trim() : null)
  )
  ipcMain.handle(CRAFT_CHANNELS.crashLatest, (_event, folder: unknown, versionId: unknown) => service.crashLatest(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.crashList, (_event, folder: unknown, versionId: unknown) => service.crashList(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.crashExport, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.crashExport(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '崩溃记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.crashAction, (_event, request: unknown) => service.crashAction(crashActionRequestArg(request)))
  service.on('crash', (diagnosis: CrashDiagnosis) => broadcast(CRAFT_CHANNELS.crashEvent, diagnosis))
}

function registerVersionIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.instanceRename, (_event, folder: unknown, versionId: unknown, nextId: unknown) =>
    service.renameInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(nextId, '新版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceCopy, (_event, folder: unknown, versionId: unknown, name: unknown) =>
    service.copyInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), typeof name === 'string' && name.trim() ? name.trim() : null)
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceDelete, (_event, folder: unknown, versionId: unknown) =>
    service.deleteInstance(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceTrash, (_event, folder: unknown) => service.trashedInstances(requiredText(folder, '游戏目录')))
  ipcMain.handle(CRAFT_CHANNELS.instanceRestore, (_event, folder: unknown, id: unknown) =>
    service.restoreInstance(requiredText(folder, '游戏目录'), requiredText(id, '回收站记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesList, (_event, folder: unknown, versionId: unknown) =>
    service.versionResources(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesScreenshots, (_event, folder: unknown, versionId: unknown) =>
    service.versionScreenshots(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesToggle, (_event, folder: unknown, versionId: unknown, file: unknown, enabled: unknown) =>
    service.resourceToggle(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.resourcesDelete, (_event, folder: unknown, versionId: unknown, kind: unknown, file: unknown) => {
    const value: ResourceKind = kind === 'shaderpacks' ? 'shaderpacks' : kind === 'saves' ? 'saves' : 'resourcepacks'
    return service.resourceDelete(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), value, requiredText(file, '文件名'))
  })
  ipcMain.handle(CRAFT_CHANNELS.instanceIconOptions, (_event, folder: unknown, versionId: unknown) =>
    service.instanceIconOptions(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceIconSet, (_event, folder: unknown, versionId: unknown, kind: unknown, ref: unknown) => {
    const value = kind === 'mod' || kind === 'save' || kind === 'server' || kind === 'file' ? kind : 'file'
    return service.setInstanceIcon(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), value, typeof ref === 'string' && ref.trim() ? ref.trim() : null)
  })
  ipcMain.handle(CRAFT_CHANNELS.instanceIconClear, (_event, folder: unknown, versionId: unknown) =>
    service.clearInstanceIcon(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.pickImage, async () => {
    const options = { title: '选择实例图标', properties: ['openFile' as const], filters: [{ name: 'PNG 图片', extensions: ['png'] }] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.crashGet, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.crashGet(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '崩溃记录'))
  )
}

function registerDevIpc(): void {
  ipcMain.handle(DEV_CHANNELS.pickProject, async () => {
    const options = { title: '选择 Fabric mod 项目目录', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(DEV_CHANNELS.fabricVersions, (_event, minecraft: unknown, mappings: unknown) =>
    dev.fabricVersions(requiredText(minecraft, ' Minecraft 版本'), mappingArg(mappings))
  )
  ipcMain.handle(DEV_CHANNELS.createFabricProject, (_event, request: unknown) => dev.createFabricProject(createRequestArg(request)))
  ipcMain.handle(DEV_CHANNELS.jbr, (_event, minecraft: unknown) => dev.jbr(typeof minecraft === 'string' && minecraft.trim() ? minecraft.trim() : undefined))
  ipcMain.handle(DEV_CHANNELS.status, (_event, projectDir: unknown) => dev.status(projectDirArg(projectDir)))
  ipcMain.handle(DEV_CHANNELS.launch, (_event, options: unknown) => dev.launch(launchOptionsArg(options)))
  ipcMain.handle(DEV_CHANNELS.stop, (_event, projectDir: unknown) => dev.stop(projectDirArg(projectDir)))
  ipcMain.handle(DEV_CHANNELS.setControl, (_event, projectDir: unknown, owner: unknown) => dev.setControl(projectDirArg(projectDir), ownerArg(owner)))
  ipcMain.handle(DEV_CHANNELS.restart, (_event, options: unknown) => dev.restart(launchOptionsArg(options)))
  ipcMain.handle(DEV_CHANNELS.build, (_event, projectDir: unknown) => dev.build(projectDirArg(projectDir)))
  ipcMain.handle(DEV_CHANNELS.apply, (_event, projectDir: unknown, autoRestart: unknown) => dev.apply(projectDirArg(projectDir), autoRestart === true))
  ipcMain.handle(DEV_CHANNELS.reloadResources, (_event, projectDir: unknown) => dev.reloadResources(projectDirArg(projectDir)))
  ipcMain.handle(DEV_CHANNELS.command, (_event, projectDir: unknown, command: unknown) =>
    dev.command(projectDirArg(projectDir), requiredText(command, '命令'))
  )
  ipcMain.handle(DEV_CHANNELS.screenshot, (_event, projectDir: unknown) => dev.screenshot(projectDirArg(projectDir)))
  ipcMain.handle(DEV_CHANNELS.render, (_event, projectDir: unknown, id: unknown, kind: unknown, size: unknown) =>
    dev.render(projectDirArg(projectDir), requiredText(id, 'id'), kind === 'block' ? 'block' : 'item', typeof size === 'number' && Number.isFinite(size) ? Math.min(Math.max(Math.round(size), 16), 1024) : 256)
  )
  ipcMain.handle(DEV_CHANNELS.logs, (_event, query: unknown) => {
    const raw = recordArg(query)
    const lines = typeof raw.lines === 'number' && Number.isFinite(raw.lines) ? Math.min(Math.max(Math.round(raw.lines), 1), 20000) : 500
    return dev.logs({
      projectDir: projectDirArg(raw.projectDir),
      lines,
      ...(typeof raw.filter === 'string' && raw.filter.trim() ? { filter: raw.filter.trim() } : {}),
      ...(Array.isArray(raw.levels) ? { levels: raw.levels.filter((level): level is 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' => level === 'ERROR' || level === 'WARN' || level === 'INFO' || level === 'DEBUG') } : {})
    })
  })
  ipcMain.handle(DEV_CHANNELS.crashes, (_event, projectDir: unknown) => dev.crashes(projectDirArg(projectDir)))
  dev.on('session', (session: unknown) => broadcast(DEV_CHANNELS.sessionEvent, session))
  dev.on('log', (event: unknown) => broadcast(DEV_CHANNELS.logEvent, event))
}

function preflightRequestArg(value: unknown): PreflightRequest {
  const raw = recordArg(value)
  const request: PreflightRequest = { folder: requiredText(raw.folder, '游戏目录'), versionId: requiredText(raw.versionId, '版本名') }
  if (typeof raw.javaPath === 'string' && raw.javaPath.trim()) request.javaPath = raw.javaPath.trim()
  if (typeof raw.maxMemoryMb === 'number' && Number.isFinite(raw.maxMemoryMb) && raw.maxMemoryMb > 0) request.maxMemoryMb = Math.round(raw.maxMemoryMb)
  return request
}

function crashActionRequestArg(value: unknown): CrashActionRequest {
  const raw = recordArg(value)
  const kinds: CrashActionRequest['kind'][] = ['install-deps', 'disable-mod', 'java', 'memory', 'mods', 'repair', 'export']
  const kind = kinds.find((item) => item === raw.kind)
  if (!kind) throw new Error('不支持的处理动作')
  return {
    folder: requiredText(raw.folder, '游戏目录'),
    versionId: requiredText(raw.versionId, '版本名'),
    diagnosisId: requiredText(raw.diagnosisId, '崩溃记录'),
    kind,
    value: typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim() : null
  }
}

function registerModsIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.instanceOverview, (_event, folder: unknown, versionId: unknown) =>
    service.instanceOverview(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.instanceSettingsUpdate, (_event, folder: unknown, versionId: unknown, patch: unknown) =>
    service.updateInstanceSettings(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), recordArg(patch) as Partial<InstanceOverride>)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsList, (_event, folder: unknown, versionId: unknown) => service.modList(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名')))
  ipcMain.handle(CRAFT_CHANNELS.modsToggle, (_event, folder: unknown, versionId: unknown, file: unknown, enabled: unknown) =>
    service.modToggle(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRemove, (_event, folder: unknown, versionId: unknown, file: unknown) =>
    service.modRemove(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(file, '文件名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsToggleMany, (_event, folder: unknown, versionId: unknown, files: unknown, enabled: unknown) =>
    service.modToggleMany(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(files), enabled === true)
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRemoveMany, (_event, folder: unknown, versionId: unknown, files: unknown) =>
    service.modRemoveMany(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(files))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsInstallDeps, (_event, folder: unknown, versionId: unknown, modIds: unknown) =>
    service.modInstallDeps(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), textList(modIds))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsRestore, (_event, folder: unknown, versionId: unknown, id: unknown) =>
    service.modRestore(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'), requiredText(id, '回收站记录'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsCheckUpdates, (_event, folder: unknown, versionId: unknown) =>
    service.modCheckUpdates(requiredText(folder, '游戏目录'), requiredText(versionId, '版本名'))
  )
  ipcMain.handle(CRAFT_CHANNELS.modsUpdate, (_event, request: unknown) => service.modUpdate(modUpdateRequestArg(request)))
  ipcMain.handle(CRAFT_CHANNELS.modsInstall, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.modInstall({
      folder: requiredText(raw.folder, '游戏目录'),
      versionId: requiredText(raw.versionId, '版本名'),
      versionFileId: requiredText(raw.versionFileId, 'Modrinth 版本')
    })
  })
  ipcMain.handle(CRAFT_CHANNELS.modsAddFiles, (_event, folder: unknown, versionId: unknown, paths: unknown) =>
    service.modAddFiles(
      requiredText(folder, '游戏目录'),
      requiredText(versionId, '版本名'),
      Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.modsSearch, (_event, query: unknown) => {
    const raw = recordArg(query)
    const sort = raw.sort === 'downloads' || raw.sort === 'updated' || raw.sort === 'newest' ? raw.sort : 'relevance'
    return service.modSearch({
      query: typeof raw.query === 'string' ? raw.query : '',
      loader: typeof raw.loader === 'string' && raw.loader.trim() ? raw.loader.trim() : null,
      minecraft: typeof raw.minecraft === 'string' && raw.minecraft.trim() ? raw.minecraft.trim() : null,
      sort,
      limit: Number.isFinite(Number(raw.limit)) ? Math.min(Math.max(Math.round(Number(raw.limit)), 1), 50) : 20,
      offset: Number.isFinite(Number(raw.offset)) ? Math.max(Math.round(Number(raw.offset)), 0) : 0
    } satisfies ModrinthSearchQuery)
  })
  ipcMain.handle(CRAFT_CHANNELS.modsVersions, (_event, projectId: unknown, loader: unknown, minecraft: unknown) =>
    service.modVersions(
      requiredText(projectId, 'Modrinth 项目'),
      typeof loader === 'string' && loader.trim() ? loader.trim() : null,
      typeof minecraft === 'string' && minecraft.trim() ? minecraft.trim() : null
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.modsProject, (_event, projectId: unknown) => service.modProject(requiredText(projectId, 'Modrinth 项目')))
  ipcMain.handle(CRAFT_CHANNELS.pickModFiles, async () => {
    const options = {
      title: '选择 Mod 文件',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Mod', extensions: ['jar'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(CRAFT_CHANNELS.openUrl, async (_event, url: unknown) => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!/^https:\/\//.test(target)) throw new Error('只能打开 https 链接')
    await shell.openExternal(target)
  })
}

function registerDownloadIpc(): void {
  ipcMain.handle(CRAFT_CHANNELS.downloadCategories, (_event, projectType: unknown) => service.downloadCategories(typeof projectType === 'string' ? projectType : 'mod'))
  ipcMain.handle(CRAFT_CHANNELS.downloadSearch, (_event, query: unknown) => {
    const raw = recordArg(query)
    const sort = raw.sort === 'downloads' || raw.sort === 'updated' || raw.sort === 'newest' ? raw.sort : 'relevance'
    const projectType = raw.projectType === 'resourcepack' ? 'resourcepack' : raw.projectType === 'shader' ? 'shader' : raw.projectType === 'modpack' ? 'modpack' : 'mod'
    return service.downloadSearch({
      projectType,
      query: typeof raw.query === 'string' ? raw.query : '',
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null,
      loader: typeof raw.loader === 'string' && raw.loader.trim() ? raw.loader.trim() : null,
      minecraft: typeof raw.minecraft === 'string' && raw.minecraft.trim() ? raw.minecraft.trim() : null,
      sort,
      limit: Number.isFinite(Number(raw.limit)) ? Math.min(Math.max(Math.round(Number(raw.limit)), 1), 50) : 20,
      offset: Number.isFinite(Number(raw.offset)) ? Math.max(Math.round(Number(raw.offset)), 0) : 0
    } satisfies ContentSearchQuery)
  })
  ipcMain.handle(CRAFT_CHANNELS.downloadVersions, (_event, projectId: unknown, loader: unknown, minecraft: unknown) =>
    service.downloadVersions(
      requiredText(projectId, 'Modrinth 项目'),
      typeof loader === 'string' && loader.trim() ? loader.trim() : null,
      typeof minecraft === 'string' && minecraft.trim() ? minecraft.trim() : null
    )
  )
  ipcMain.handle(CRAFT_CHANNELS.downloadInstall, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.downloadInstall({
      folder: requiredText(raw.folder, '游戏目录'),
      versionId: requiredText(raw.versionId, '版本名'),
      projectType: raw.projectType === 'shader' ? 'shader' : 'resourcepack',
      versionFileId: requiredText(raw.versionFileId, 'Modrinth 版本')
    })
  })
  ipcMain.handle(CRAFT_CHANNELS.pickModpack, async () => {
    const options = {
      title: '选择 Modrinth 整合包',
      properties: ['openFile' as const],
      filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CRAFT_CHANNELS.inspectModpack, (_event, path: unknown) => service.inspectModpack(requiredText(path, '整合包路径')))
  ipcMain.handle(CRAFT_CHANNELS.importModpack, (_event, request: unknown) => {
    const raw = recordArg(request)
    return service.importModpack({
      folder: requiredText(raw.folder, '游戏目录'),
      path: requiredText(raw.path, '整合包路径'),
      ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim() } : {})
    })
  })
}

function modUpdateRequestArg(value: unknown) {
  const raw = recordArg(value)
  const updates = Array.isArray(raw.updates) ? (raw.updates.filter((item) => !!item && typeof item === 'object') as ModUpdateInfo[]) : []
  return { folder: requiredText(raw.folder, '游戏目录'), versionId: requiredText(raw.versionId, '版本名'), updates }
}

function recordArg(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
}

function projectDirArg(value: unknown): string {
  const dir = typeof value === 'string' ? value.trim() : ''
  if (!dir) throw new Error('缺少项目目录')
  return dir
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`缺少${label}`)
  return text
}

function mappingArg(value: unknown): MappingFlavor {
  return value === 'mojmap' ? 'mojmap' : 'yarn'
}

function ownerArg(value: unknown): CompanionOwner {
  if (value === 'agent' || value === 'user') return value
  throw new Error('控制方只能是 agent 或 user')
}

function launchOptionsArg(value: unknown): DevLaunchOptions {
  const raw = recordArg(value)
  const options: DevLaunchOptions = { projectDir: projectDirArg(raw.projectDir) }
  if (typeof raw.world === 'string' && raw.world.trim()) options.world = raw.world.trim()
  if (typeof raw.javaPath === 'string' && raw.javaPath.trim()) options.javaPath = raw.javaPath.trim()
  if (typeof raw.maxMemoryMb === 'number' && Number.isFinite(raw.maxMemoryMb) && raw.maxMemoryMb > 0) options.maxMemoryMb = Math.round(raw.maxMemoryMb)
  if (raw.requireJbr === true) options.requireJbr = true
  if (raw.waitFor === 'process' || raw.waitFor === 'companion' || raw.waitFor === 'world') options.waitFor = raw.waitFor
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) options.timeoutMs = Math.round(raw.timeoutMs)
  return options
}

function createRequestArg(value: unknown): CreateFabricProjectRequest {
  const raw = recordArg(value)
  const request: CreateFabricProjectRequest = {
    minecraftVersion: requiredText(raw.minecraftVersion, ' Minecraft 版本'),
    modId: requiredText(raw.modId, 'mod id'),
    packageName: requiredText(raw.packageName, '包名'),
    targetDir: requiredText(raw.targetDir, '目标目录')
  }
  if (typeof raw.modName === 'string' && raw.modName.trim()) request.modName = raw.modName.trim()
  if (raw.mappings === 'yarn' || raw.mappings === 'mojmap') request.mappings = raw.mappings
  if (typeof raw.javaPath === 'string' && raw.javaPath.trim()) request.javaPath = raw.javaPath.trim()
  if (typeof raw.versions === 'object' && raw.versions !== null) request.versions = raw.versions as Partial<FabricVersionSet>
  return request
}

function installRequestArg(value: unknown): InstallRequest {
  const raw = recordArg(value)
  const kind = raw.kind === 'vanilla' || raw.kind === 'fabric' || raw.kind === 'quilt' || raw.kind === 'forge' || raw.kind === 'neoforge' ? raw.kind : null
  if (!kind) throw new Error('这个加载器还不支持安装')
  const request: InstallRequest = {
    folder: requiredText(raw.folder, '游戏目录'),
    kind,
    minecraft: requiredText(raw.minecraft, ' Minecraft 版本')
  }
  if (typeof raw.loader === 'string' && raw.loader.trim()) request.loader = raw.loader.trim()
  if (typeof raw.name === 'string' && raw.name.trim()) request.name = raw.name.trim()
  if (raw.companions === false) request.companions = false
  return request
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.yudatoux.inkstone.minecraft')
    registerIpc()
    registerDevIpc()
    registerModsIpc()
    registerDownloadIpc()
    registerVersionIpc()
    applyTheme(await service.settings())
    window = createWindow()
    nativeTheme.on('updated', () => {
      if (!window || window.isDestroyed()) return
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151515' : '#FCFCFB')
      if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarColors())
    })
    window.on('closed', () => {
      window = null
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    dev.dispose()
    service.dispose()
  })
}
