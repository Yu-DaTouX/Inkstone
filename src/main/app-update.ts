import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdateStatus } from '../shared/app-update'
import type { IpcRegistrar } from './ipc/registrar'

const RELEASES = 'https://github.com/Yu-DaTouX/Inkstone/releases'
/** Installed NSIS builds consume GitHub's generated updater metadata. Development and
 * portable builds still expose release checks without pretending they can replace themselves. */
export function registerAppUpdate(ipc: IpcRegistrar, busy: () => boolean): void {
  const state: AppUpdateStatus = { phase: 'idle', current: app.getVersion(), automatic: true, packaged: app.isPackaged, releaseUrl: RELEASES }
  const preferences = join(app.getPath('userData'), 'update-preferences.json')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.setFeedURL({ provider: 'github', owner: 'Yu-DaTouX', repo: 'Inkstone' })
  autoUpdater.on('error', (error) => { state.phase = 'error'; state.error = error.message })
  autoUpdater.on('download-progress', (progress) => { state.phase = 'downloading'; state.percent = progress.percent })
  autoUpdater.on('update-downloaded', () => { state.phase = 'downloaded'; state.percent = 100 })
  let checking: Promise<AppUpdateStatus> | null = null
  const check = (): Promise<AppUpdateStatus> => {
    if (checking) return checking
    if (state.phase === 'downloading' || state.phase === 'downloaded') return Promise.resolve({ ...state })
    checking = (async () => {
      state.phase = 'checking'; state.error = undefined
      try {
        const response = await net.fetch('https://api.github.com/repos/Yu-DaTouX/Inkstone/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
        const release = await response.json() as { tag_name: string; html_url: string; assets: { name: string }[] }
        state.latest = release.tag_name.replace(/^v/, ''); state.releaseUrl = release.html_url || RELEASES
        const parts = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
        const latest = parts(state.latest), current = parts(state.current)
        let newer = false
        for (let i = 0; i < Math.max(latest.length, current.length); i++) { if ((latest[i] ?? 0) !== (current[i] ?? 0)) { newer = (latest[i] ?? 0) > (current[i] ?? 0); break } }
        if (!newer) state.phase = 'current'
        else if (!app.isPackaged || !!process.env.PORTABLE_EXECUTABLE_FILE || !!process.env.PORTABLE_EXECUTABLE_DIR || !release.assets.some((asset) => asset.name === 'latest.yml')) state.phase = 'manual'
        else { const result = await autoUpdater.checkForUpdates(); state.phase = result?.updateInfo && result.updateInfo.version !== state.current ? 'available' : 'current' }
      } catch (error) { state.phase = 'error'; state.error = error instanceof Error ? error.message : String(error) }
      return { ...state }
    })().finally(() => { checking = null })
    return checking
  }
  /* 偏好文件读完之前，status 不能返回默认的 automatic: true */
  let prefsLoaded: Promise<void> = Promise.resolve()
  ipc.handle('yan:update:status', async () => { await prefsLoaded; return { ...state } })
  ipc.handle('yan:update:check', check)
  ipc.handle('yan:update:automatic', async (enabled: boolean) => { state.automatic = enabled === true; await writeFile(preferences, JSON.stringify({ automatic: state.automatic })); return { ...state } })
  ipc.handle('yan:update:download', async () => {
    if (state.phase !== 'available') return { ...state }
    state.phase = 'downloading'; state.percent = 0
    void autoUpdater.downloadUpdate().catch((error) => { state.phase = 'error'; state.error = String(error) })
    return { ...state }
  })
  ipc.handle('yan:update:install', () => {
    if (state.phase !== 'downloaded') return { ok: false, error: '更新尚未下载完成' }
    if (busy()) return { ok: false, error: '请等任务结束后再重启安装' }
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 300)
    return { ok: true }
  })
  prefsLoaded = readFile(preferences, 'utf8').then((value) => { state.automatic = JSON.parse(value).automatic !== false }).catch(() => undefined).finally(() => {
    if (app.isPackaged && state.automatic) void check()
  })
}
