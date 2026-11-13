import type { BrowserWindow } from 'electron'
import { dialog, session } from 'electron'
import { isAbsolute } from 'node:path'
import type { IpcRegistrar } from './registrar'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import type { LineModel } from '../native-compaction-line'
import type { MainPush } from '../../shared/ipc'
import { pick } from '../../shared/ui-lang'
import { getSettings, patchSettings, updateSettings, validateRendererSettingsPatch } from '../settings'
import { readPiNativeSettings, readPiRuntimePrefs, writePiNativeSettings } from '../pi-runtime-prefs'
import { pinnedGuardStatus, pinnedRoutingStatus } from '../net/pinned-network'
import { cancelStorageMove, scheduleStorageMove, storageInfo, storageSize, syncFolderService } from '../storage-move'

type Settings = Awaited<ReturnType<typeof getSettings>>

export interface SettingsIpcDeps {
  win(): BrowserWindow | null
  runners(): RunnerRegistry | null
  ac(): AgentController | null
  starting(): Promise<{ ok: boolean; error?: string }> | null
  push(msg: MainPush): void
  isObject(value: unknown): value is Record<string, unknown>
  validateCwd(cwd: unknown): Promise<{ ok: true; cwd: string } | { ok: false; error: string }>
  normalizeCwdForIdentity(value: string): string
  reportMainError(kind: string, error: unknown): void
  refreshPackageProjectRoots(settings: Settings): void
  syncNativeThemeSource(theme: 'light' | 'dark'): void
  setTrayLanguage(lang: Settings['lang']): void
  refreshTrayMenu(): void
  setResponseDetail(detail: Settings['responseDetail']): void
  syncCompactionLines(models: LineModel[]): Promise<void>
  syncKeepAwake(working: boolean): Promise<void>
  requestExit(options: { relaunch?: boolean; source?: string }): Promise<{ action: 'cancelled' | 'save-and-exit' | 'interrupt-exit' | 'already-exiting' }>
}

export function registerSettingsIpc(ipc: IpcRegistrar, deps: SettingsIpcDeps): void {
  const { handle } = ipc
  const {
    ac, push, isObject, validateCwd, normalizeCwdForIdentity, reportMainError, refreshPackageProjectRoots, syncNativeThemeSource,
    refreshTrayMenu, syncCompactionLines, syncKeepAwake, requestExit
  } = deps

  handle('yan:piRuntimePrefs', async () => readPiRuntimePrefs())
  handle('yan:piNativeSettings', async () => readPiNativeSettings())
  handle('yan:setPiNativeSettings', async (patch: unknown) => writePiNativeSettings(patch))
  handle('yan:pinnedNetworkStatus', () => ({
    guard: pinnedGuardStatus(session.defaultSession),
    routing: pinnedRoutingStatus()
  }))
  handle('yan:getSettings', async () => {
    const s = await getSettings()
    return { ...s, lang: s.lang, theme: s.theme }
  })
  handle('yan:removeGuardAllowRoot', async (path: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error(pick('目录无效', 'Invalid folder'))
    const current = await getSettings()
    const roots = current.guardAllowRoots ?? []
    const next = roots.filter((root) => root !== path)
    if (next.length === roots.length) return current
    return patchSettings({ guardAllowRoots: next })
  })
  handle('yan:patchSettings', async (rawPatch: unknown) => {
    const patch = validateRendererSettingsPatch(rawPatch)
    const before = await getSettings()
    if ('cwd' in patch) {
      const checked = await validateCwd(patch.cwd)
      if (!checked.ok) throw new Error(checked.error)
      patch.cwd = checked.cwd
    }
    if ('projects' in patch) {
      if (!Array.isArray(patch.projects)) throw new Error(pick('项目列表格式无效', 'Invalid project list'))
      const ids = new Set<string>()
      for (const project of patch.projects) {
        if (!isObject(project) || typeof project.id !== 'string' || !project.id || typeof project.cwd !== 'string' || !isAbsolute(project.cwd) || ids.has(project.id)) throw new Error(pick('项目标识或目录格式无效', 'Invalid project id or folder'))
        ids.add(project.id)
        const previous = before.projects.find((item) => item.id === project.id)
        if (previous && normalizeCwdForIdentity(previous.cwd) !== normalizeCwdForIdentity(project.cwd)) throw new Error(pick('不能将已有项目标识重新绑定到其他目录', 'Cannot rebind an existing project id to another folder'))
        if (!previous) {
          const checked = await validateCwd(project.cwd)
          if (!checked.ok) throw new Error(checked.error)
          project.cwd = checked.cwd
        }
      }
    }
    let next: Awaited<ReturnType<typeof patchSettings>>
    try {
      next = await updateSettings((current) => {
        for (const project of patch.projects ?? []) {
          const previous = current.projects.find((item) => item.id === project.id)
          if (previous && normalizeCwdForIdentity(previous.cwd) !== normalizeCwdForIdentity(project.cwd)) {
            throw new Error(pick('项目文件夹已变化，请刷新后重试', 'Project folder changed; refresh and retry'))
          }
        }
        return patch as never
      })
    } catch (e) {
      reportMainError('设置', e)
      throw e
    }
    refreshPackageProjectRoots(next)
    if (typeof patch.theme === 'string' && patch.theme !== before.theme) {
      syncNativeThemeSource(next.theme)
    }
    if (typeof patch.lang === 'string' && patch.lang !== before.lang) {
      deps.setTrayLanguage(next.lang)
      refreshTrayMenu()
      push({
        ch: 'log',
        payload: {
          text: `[语言] 已切换为 ${next.lang}；下一轮开始，推理与回复都跟随新语言（不重建实例、不中断会话）。`
        }
      })
    }
    if (patch.responseDetail !== undefined) deps.setResponseDetail(next.responseDetail)
    if ('autoCompactTokens' in patch) void ac()?.listModels().then(syncCompactionLines)
    if ('keepAwakeWhileWorking' in patch || 'keepAwakeOnBattery' in patch) void syncKeepAwake((deps.runners()?.statuses() ?? []).some((r) => r.running))
    return next
  })
  handle('yan:storage:info', async () => {
    const info = storageInfo()
    return { ...info, bytes: await storageSize(info.realDir) }
  })
  handle('yan:storage:pick', async () => {
    if (!deps.win()) return null
    const r = await dialog.showOpenDialog(deps.win()!, { title: pick('选择新的数据位置（建议非系统盘上的空文件夹）', 'Choose new data location (an empty folder off the system drive)'), properties: ['openDirectory', 'createDirectory'] })
    const picked = r.canceled ? null : r.filePaths[0] ?? null
    const service = picked ? syncFolderService(picked) : null
    if (!picked || !service) return picked
    const answer = await dialog.showMessageBox(deps.win()!, {
      type: 'warning',
      title: pick('这是同步盘文件夹', 'This is a synced folder'),
      message: pick(`选中的文件夹由 ${service} 同步`, `The selected folder is synced by ${service}`),
      detail: pick('数据目录里有模型 API Key 与登录凭证（auth.json），放在同步盘会被上传到云端或其他设备。建议换一个不同步的文件夹。', 'The data folder holds model API keys and login credentials (auth.json); on a synced drive they would be uploaded to the cloud or other devices. Choose a folder that is not synced.'),
      buttons: [pick('重新选择', 'Choose again'), pick('仍然使用', 'Use anyway')],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return answer.response === 1 ? picked : null
  })
  handle('yan:storage:schedule', async (target: string, relaunch?: boolean) => {
    const r = await scheduleStorageMove(String(target ?? ''))
    if (!r.ok || !relaunch) return r
    const exit = await requestExit({ relaunch: true, source: 'storage-relaunch' })
    if (exit.action === 'cancelled') {
      cancelStorageMove()
      return { ok: false, error: pick('仍有会话在运行，已取消迁移', 'Sessions are still running; move canceled') }
    }
    return r
  })
  handle('yan:storage:cancel', async () => {
    cancelStorageMove()
  })
  handle('yan:setCwd', async (cwd: string) => {
    const cwdResult = await validateCwd(cwd)
    if (!cwdResult.ok) return cwdResult
    await patchSettings({ cwd: cwdResult.cwd })
    if (deps.starting()) await deps.starting()
    return { ok: true, cwd: cwdResult.cwd }
  })
}
