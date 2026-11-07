import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdateStatus, AppUpdateWhatsNew } from '../shared/app-update'
import type { IpcRegistrar } from './ipc/registrar'
import { pick } from '../shared/ui-lang'

const RELEASES = 'https://github.com/Yu-DaTouX/Inkstone/releases'
const RELEASES_API = 'https://api.github.com/repos/Yu-DaTouX/Inkstone/releases'
const BACKGROUND_CHECK_MS = 6 * 60 * 60 * 1000
const NOTES_MAX_CHARS = 20_000

interface UpdatePreferences {
  automatic?: boolean
  seenVersion?: string
  notes?: { version: string; text: string }
}

export function registerAppUpdate(ipc: IpcRegistrar, busy: () => boolean): void {
  const state: AppUpdateStatus = { phase: 'idle', current: app.getVersion(), automatic: true, packaged: app.isPackaged, releaseUrl: RELEASES }
  const preferences = join(app.getPath('userData'), 'update-preferences.json')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.setFeedURL({ provider: 'github', owner: 'Yu-DaTouX', repo: 'Inkstone' })
  autoUpdater.on('error', (error) => { state.phase = 'error'; state.error = error.message })
  autoUpdater.on('download-progress', (progress) => { state.phase = 'downloading'; state.percent = progress.percent })
  let prefs: UpdatePreferences = {}
  let latestNotes: { version: string; text: string } | undefined
  const readPrefs = async (): Promise<void> => {
    prefs = await readFile(preferences, 'utf8').then((value) => JSON.parse(value) as UpdatePreferences).catch(() => prefs)
  }
  const savePrefs = (): Promise<void> => writeFile(preferences, JSON.stringify(prefs)).catch(() => undefined)
  const syncInstallOnQuit = (): void => { autoUpdater.autoInstallOnAppQuit = app.isPackaged && state.automatic }
  autoUpdater.on('update-downloaded', () => {
    state.phase = 'downloaded'
    state.percent = 100
    if (latestNotes) { prefs.notes = latestNotes; void savePrefs() }
  })
  const startDownload = (): void => {
    state.phase = 'downloading'
    state.percent = 0
    void autoUpdater.downloadUpdate().catch((error) => { state.phase = 'error'; state.error = String(error) })
  }
  let checking: Promise<AppUpdateStatus> | null = null
  const check = (): Promise<AppUpdateStatus> => {
    if (checking) return checking
    if (state.phase === 'downloading' || state.phase === 'downloaded') return Promise.resolve({ ...state })
    checking = (async () => {
      state.phase = 'checking'; state.error = undefined
      try {
        const response = await net.fetch('https://api.github.com/repos/Yu-DaTouX/Inkstone/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
        const release = await response.json() as { tag_name: string; html_url: string; assets: { name: string }[]; body?: string }
        state.latest = release.tag_name.replace(/^v/, ''); state.releaseUrl = release.html_url || RELEASES
        latestNotes = release.body?.trim() ? { version: state.latest, text: release.body.trim().slice(0, NOTES_MAX_CHARS) } : undefined
        const parts = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
        const latest = parts(state.latest), current = parts(state.current)
        let newer = false
        for (let i = 0; i < Math.max(latest.length, current.length); i++) { if ((latest[i] ?? 0) !== (current[i] ?? 0)) { newer = (latest[i] ?? 0) > (current[i] ?? 0); break } }
        if (!newer) state.phase = 'current'
        else if (!app.isPackaged || !!process.env.PORTABLE_EXECUTABLE_FILE || !!process.env.PORTABLE_EXECUTABLE_DIR || !release.assets.some((asset) => asset.name === 'latest.yml')) state.phase = 'manual'
        else { const result = await autoUpdater.checkForUpdates(); state.phase = result?.updateInfo && result.updateInfo.version !== state.current ? 'available' : 'current' }
      } catch (error) { state.phase = 'error'; state.error = error instanceof Error ? error.message : String(error) }
      if (state.phase === 'available' && state.automatic) startDownload()
      return { ...state }
    })().finally(() => { checking = null })
    return checking
  }
  let prefsLoaded: Promise<void> = Promise.resolve()
  ipc.handle('yan:update:status', async () => { await prefsLoaded; return { ...state } })
  ipc.handle('yan:update:check', check)
  ipc.handle('yan:update:automatic', async (enabled: boolean) => {
    state.automatic = enabled === true
    prefs.automatic = state.automatic
    syncInstallOnQuit()
    await writeFile(preferences, JSON.stringify(prefs))
    if (state.phase === 'available' && state.automatic) startDownload()
    return { ...state }
  })
  ipc.handle('yan:update:whatsNew', async (): Promise<AppUpdateWhatsNew | null> => {
    await prefsLoaded
    await readPrefs()
    const version = state.current
    if (prefs.seenVersion === version) return null
    if (!prefs.seenVersion) {
      prefs.seenVersion = version
      await savePrefs()
      return null
    }
    let notes = prefs.notes?.version === version ? prefs.notes.text : ''
    if (!notes) {
      const response = await net.fetch(`${RELEASES_API}/tags/v${version}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
      const release = response?.ok ? await response.json().catch(() => null) as { body?: string } | null : null
      notes = release?.body?.trim().slice(0, NOTES_MAX_CHARS) ?? ''
    }
    if (notes) return { version, notes }
    prefs.seenVersion = version
    await savePrefs()
    return null
  })
  ipc.handle('yan:update:whatsNewSeen', async (version: unknown) => {
    if (version !== state.current) return
    prefs.seenVersion = state.current
    delete prefs.notes
    await savePrefs()
  })
  ipc.handle('yan:update:download', async () => {
    if (state.phase !== 'available') return { ...state }
    startDownload()
    return { ...state }
  })
  ipc.handle('yan:update:install', () => {
    if (state.phase !== 'downloaded') return { ok: false, error: pick('更新尚未下载完成', 'The update has not finished downloading') }
    if (busy()) return { ok: false, error: pick('请等任务结束并保存文件后再重启安装', 'Finish running tasks and save your files, then restart to install') }
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300)
    return { ok: true }
  })
  prefsLoaded = readPrefs().then(() => {
    state.automatic = prefs.automatic !== false
    syncInstallOnQuit()
    if (!app.isPackaged) return
    if (state.automatic) void check()
    setInterval(() => { if (state.automatic) void check() }, BACKGROUND_CHECK_MS).unref()
  })
}
