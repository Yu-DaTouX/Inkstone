import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CraftApi, LaunchStatus, LogLine, TaskInfo } from '../shared/api.ts'
import type { CrashDiagnosis } from '../shared/crash-api.ts'
import { CRAFT_CHANNELS } from '../shared/channels.ts'
import type { DevApi, DevSessionInfo } from '../shared/dev-api.ts'
import { DEV_CHANNELS } from '../shared/dev-api.ts'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: CraftApi = {
  settings: () => ipcRenderer.invoke(CRAFT_CHANNELS.settings),
  updateSettings: (patch) => ipcRenderer.invoke(CRAFT_CHANNELS.updateSettings, patch),
  instances: (folder) => ipcRenderer.invoke(CRAFT_CHANNELS.instances, folder),
  minecraftVersions: () => ipcRenderer.invoke(CRAFT_CHANNELS.installVersions),
  loaderVersions: (kind, minecraft) => ipcRenderer.invoke(CRAFT_CHANNELS.installLoaders, kind, minecraft),
  install: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.installStart, request),
  repair: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.repair, folder, versionId),
  onInstancesChanged: (listener) => subscribe<string>(CRAFT_CHANNELS.instancesChanged, listener),
  javas: () => ipcRenderer.invoke(CRAFT_CHANNELS.javas),
  pclSnapshot: () => ipcRenderer.invoke(CRAFT_CHANNELS.pclSnapshot),
  importPcl: () => ipcRenderer.invoke(CRAFT_CHANNELS.importPcl),
  addOfflineAccount: (name) => ipcRenderer.invoke(CRAFT_CHANNELS.addOfflineAccount, name),
  removeAccount: (id) => ipcRenderer.invoke(CRAFT_CHANNELS.removeAccount, id),
  selectAccount: (id) => ipcRenderer.invoke(CRAFT_CHANNELS.selectAccount, id),
  skin: (id) => ipcRenderer.invoke(CRAFT_CHANNELS.skin, id),
  instanceIcon: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.instanceIcon, folder, versionId),
  openFolder: (folder, versionId, target) => ipcRenderer.invoke(CRAFT_CHANNELS.openFolder, folder, versionId, target),
  tasks: () => ipcRenderer.invoke(CRAFT_CHANNELS.tasks),
  cancelTask: (id) => ipcRenderer.invoke(CRAFT_CHANNELS.cancelTask, id),
  clearFinishedTasks: () => ipcRenderer.invoke(CRAFT_CHANNELS.clearFinishedTasks),
  onTask: (listener) => subscribe<TaskInfo>(CRAFT_CHANNELS.taskEvent, listener),
  pickFolder: () => ipcRenderer.invoke(CRAFT_CHANNELS.pickFolder),
  launch: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.launch, request),
  stop: () => ipcRenderer.invoke(CRAFT_CHANNELS.stop),
  status: () => ipcRenderer.invoke(CRAFT_CHANNELS.status),
  logs: () => ipcRenderer.invoke(CRAFT_CHANNELS.logs),
  onLog: (listener) => subscribe<LogLine>(CRAFT_CHANNELS.logEvent, listener),
  onStatus: (listener) => subscribe<LaunchStatus>(CRAFT_CHANNELS.statusEvent, listener),
  preflight: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.preflight, request),
  launchJava: (folder, versionId, javaPath) => ipcRenderer.invoke(CRAFT_CHANNELS.launchJava, folder, versionId, javaPath),
  crashLatest: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.crashLatest, folder, versionId),
  crashList: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.crashList, folder, versionId),
  crashExport: (folder, versionId, id) => ipcRenderer.invoke(CRAFT_CHANNELS.crashExport, folder, versionId, id),
  crashAction: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.crashAction, request),
  onCrash: (listener) => subscribe<CrashDiagnosis>(CRAFT_CHANNELS.crashEvent, listener),
  instanceOverview: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.instanceOverview, folder, versionId),
  updateInstanceSettings: (folder, versionId, patch) => ipcRenderer.invoke(CRAFT_CHANNELS.instanceSettingsUpdate, folder, versionId, patch),
  modList: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.modsList, folder, versionId),
  modToggle: (folder, versionId, file, enabled) => ipcRenderer.invoke(CRAFT_CHANNELS.modsToggle, folder, versionId, file, enabled),
  modRemove: (folder, versionId, file) => ipcRenderer.invoke(CRAFT_CHANNELS.modsRemove, folder, versionId, file),
  modRestore: (folder, versionId, id) => ipcRenderer.invoke(CRAFT_CHANNELS.modsRestore, folder, versionId, id),
  modCheckUpdates: (folder, versionId) => ipcRenderer.invoke(CRAFT_CHANNELS.modsCheckUpdates, folder, versionId),
  modUpdate: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.modsUpdate, request),
  modInstall: (request) => ipcRenderer.invoke(CRAFT_CHANNELS.modsInstall, request),
  modAddFiles: (folder, versionId, paths) => ipcRenderer.invoke(CRAFT_CHANNELS.modsAddFiles, folder, versionId, paths),
  pickModFiles: () => ipcRenderer.invoke(CRAFT_CHANNELS.pickModFiles),
  modSearch: (query) => ipcRenderer.invoke(CRAFT_CHANNELS.modsSearch, query),
  modVersions: (projectId, loader, minecraft) => ipcRenderer.invoke(CRAFT_CHANNELS.modsVersions, projectId, loader, minecraft),
  modProject: (projectId) => ipcRenderer.invoke(CRAFT_CHANNELS.modsProject, projectId),
  openUrl: (url) => ipcRenderer.invoke(CRAFT_CHANNELS.openUrl, url)
}

contextBridge.exposeInMainWorld('craft', api)

const dev: DevApi = {
  pickProject: () => ipcRenderer.invoke(DEV_CHANNELS.pickProject),
  fabricVersions: (minecraftVersion, mappings) => ipcRenderer.invoke(DEV_CHANNELS.fabricVersions, minecraftVersion, mappings),
  createFabricProject: (request) => ipcRenderer.invoke(DEV_CHANNELS.createFabricProject, request),
  jbr: (minecraftVersion) => ipcRenderer.invoke(DEV_CHANNELS.jbr, minecraftVersion),
  status: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.status, projectDir),
  launch: (options) => ipcRenderer.invoke(DEV_CHANNELS.launch, options),
  stop: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.stop, projectDir),
  setControl: (projectDir, owner) => ipcRenderer.invoke(DEV_CHANNELS.setControl, projectDir, owner),
  restart: (options) => ipcRenderer.invoke(DEV_CHANNELS.restart, options),
  build: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.build, projectDir),
  apply: (projectDir, autoRestart) => ipcRenderer.invoke(DEV_CHANNELS.apply, projectDir, autoRestart),
  reloadResources: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.reloadResources, projectDir),
  command: (projectDir, command) => ipcRenderer.invoke(DEV_CHANNELS.command, projectDir, command),
  screenshot: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.screenshot, projectDir),
  render: (projectDir, id, kind, size) => ipcRenderer.invoke(DEV_CHANNELS.render, projectDir, id, kind, size),
  logs: (query) => ipcRenderer.invoke(DEV_CHANNELS.logs, query),
  crashes: (projectDir) => ipcRenderer.invoke(DEV_CHANNELS.crashes, projectDir),
  onSession: (listener) => subscribe<DevSessionInfo>(DEV_CHANNELS.sessionEvent, listener),
  onLog: (listener) => subscribe<{ projectDir: string; text: string }>(DEV_CHANNELS.logEvent, listener)
}

contextBridge.exposeInMainWorld('craftDev', dev)
