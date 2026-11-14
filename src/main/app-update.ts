import { app, BrowserWindow, dialog, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startupInstallDue, type AppUpdateStatus, type AppUpdateWhatsNew } from '../shared/app-update'
import type { BackupSummary } from '../shared/data-backup'
import type { IpcRegistrar } from './ipc/registrar'
import { createUpdateAutoBackup } from './data-backup'
import { SESSIONS_DIR } from './sessions'
import { YAN_DIR } from './paths'
import { pick } from '../shared/ui-lang'

const RELEASES = 'https://github.com/Yu-DaTouX/Inkstone/releases'
const RELEASES_API = 'https://api.github.com/repos/Yu-DaTouX/Inkstone/releases'
const BACKGROUND_CHECK_MS = 6 * 60 * 60 * 1000
const NOTES_MAX_CHARS = 20_000

interface UpdatePreferences {
  automatic?: boolean
  seenVersion?: string
  notes?: { version: string; text: string }
  pending?: string
}

export interface AutomaticInstallPreparation {
  install: boolean
  reason: 'no-update' | 'disabled' | 'backed-up' | 'accepted-without-backup' | 'cancelled' | 'aborted' | 'failed'
  backup?: BackupSummary
}

export interface AutomaticInstallPreparationOptions {
  signal?: AbortSignal
}

export interface AppUpdateControl {
  prepareAutomaticInstallOnQuit(options?: AutomaticInstallPreparationOptions): Promise<AutomaticInstallPreparation>
  cancelAutomaticInstallPreparation(): void
}

function messageWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.find((win) => !win.isDestroyed()) ?? null
}

export function registerAppUpdate(ipc: IpcRegistrar, busy: () => boolean, backup?: () => Promise<BackupSummary>): AppUpdateControl {
  const runBackup = backup ?? (() => createUpdateAutoBackup({ userData: app.getPath('userData'), sessions: SESSIONS_DIR, yan: YAN_DIR }))
  const state: AppUpdateStatus = { phase: 'idle', current: app.getVersion(), automatic: true, packaged: app.isPackaged, releaseUrl: RELEASES }
  const preferences = join(app.getPath('userData'), 'update-preferences.json')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.setFeedURL({ provider: 'github', owner: 'Yu-DaTouX', repo: 'Inkstone' })
  autoUpdater.on('error', (error) => { state.phase = 'error'; state.error = error.message })
  autoUpdater.on('download-progress', (progress) => { state.phase = 'downloading'; state.percent = progress.percent })
  let prefs: UpdatePreferences = {}
  let installing = false
  let latestNotes: { version: string; text: string } | undefined
  const readPrefs = async (): Promise<void> => {
    prefs = await readFile(preferences, 'utf8').then((value) => JSON.parse(value) as UpdatePreferences).catch(() => prefs)
  }
  let prefsWrite: Promise<void> = Promise.resolve()
  const writePrefs = (): Promise<void> => {
    const next = prefsWrite.catch(() => undefined).then(async () => {
      const temp = `${preferences}.tmp`
      await writeFile(temp, JSON.stringify(prefs))
      await rename(temp, preferences)
    })
    prefsWrite = next
    return next
  }
  const savePrefs = (): Promise<void> => writePrefs().catch(() => undefined)
  let preparing: Promise<AutomaticInstallPreparation> | null = null
  let prepareAbort: AbortController | null = null
  let manualInstall: { reason: 'backed-up' | 'accepted-without-backup'; backup?: BackupSummary } | null = null
  const askWithoutBackup = async (reason: string): Promise<boolean> => {
    const options = {
      type: 'warning' as const,
      title: pick('安装前备份失败', 'Pre-install backup failed'),
      message: pick('退出前没能备份当前数据，还要在这次退出时安装更新吗？', 'The data could not be backed up before quitting. Still install the update when the app exits?'),
      detail: pick(`原因：${reason}\n\n不带备份安装，更新后出问题时无法用本次备份恢复。选「取消安装」只退出，不安装这次更新。`, `Reason: ${reason}\n\nWithout a backup, a problem after updating cannot be recovered from this backup. Choosing "Cancel install" only quits; the update stays downloaded.`),
      buttons: [pick('继续安装', 'Install anyway'), pick('取消安装', 'Cancel install')],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const win = messageWindow()
    const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return answer.response === 0
  }
  const prepareAutomaticInstallOnQuit = (input: AutomaticInstallPreparationOptions = {}): Promise<AutomaticInstallPreparation> => {
    if (preparing) {
      if (input.signal) {
        if (input.signal.aborted) prepareAbort?.abort()
        else input.signal.addEventListener('abort', () => prepareAbort?.abort(), { once: true })
      }
      return preparing
    }
    const controller = new AbortController()
    prepareAbort = controller
    if (input.signal) {
      if (input.signal.aborted) controller.abort()
      else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const aborted = (): boolean => controller.signal.aborted
    preparing = (async (): Promise<AutomaticInstallPreparation> => {
      autoUpdater.autoInstallOnAppQuit = false
      if (manualInstall) return { install: true, reason: manualInstall.reason, ...(manualInstall.backup ? { backup: manualInstall.backup } : {}) }
      if (aborted()) return { install: false, reason: 'aborted' }
      if (state.phase !== 'downloaded') return { install: false, reason: 'no-update' }
      if (!app.isPackaged || !state.automatic) return { install: false, reason: 'disabled' }
      try {
        const summary = await runBackup()
        if (aborted()) return { install: false, reason: 'aborted' }
        autoUpdater.autoInstallOnAppQuit = true
        state.error = undefined
        return { install: true, reason: 'backed-up', backup: summary }
      } catch (error) {
        if (aborted()) return { install: false, reason: 'aborted' }
        const reason = error instanceof Error ? error.message : String(error)
        const proceed = await askWithoutBackup(reason)
        if (aborted()) return { install: false, reason: 'aborted' }
        if (proceed) {
          autoUpdater.autoInstallOnAppQuit = true
          return { install: true, reason: 'accepted-without-backup' }
        }
        state.error = pick('安装前自动备份失败，这次退出不安装更新', 'The pre-install backup failed; the update will not be installed on this quit')
        return { install: false, reason: 'cancelled' }
      }
    })()
      .catch((error) => {
        autoUpdater.autoInstallOnAppQuit = false
        if (!aborted()) state.error = pick(`退出前准备安装失败：${error instanceof Error ? error.message : String(error)}`, `Preparing the install before quitting failed: ${error instanceof Error ? error.message : String(error)}`)
        return { install: false, reason: aborted() ? 'aborted' as const : 'failed' as const }
      })
      .finally(() => {
        if (prepareAbort === controller) prepareAbort = null
        preparing = null
      })
    return preparing
  }
  const cancelAutomaticInstallPreparation = (): void => { prepareAbort?.abort() }
  const launchedAt = Date.now()
  let launchPending: string | undefined
  autoUpdater.on('update-downloaded', (info?: { version?: string }) => {
    state.phase = 'downloaded'
    state.percent = 100
    manualInstall = null
    const version = info?.version ?? state.latest
    if (latestNotes) prefs.notes = latestNotes
    if (version) prefs.pending = version
    void savePrefs()
    if (startupInstallDue({ pending: launchPending, downloaded: version, current: state.current, automatic: state.automatic, busy: busy() || installing, sinceLaunchMs: Date.now() - launchedAt })) void startupInstall()
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
    autoUpdater.autoInstallOnAppQuit = false
    await writePrefs()
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
  ipc.handle('yan:update:install', async () => {
    if (state.phase !== 'downloaded') return { ok: false, error: pick('更新尚未下载完成', 'The update has not finished downloading') }
    if (busy()) return { ok: false, error: pick('请等任务结束并保存文件后再重启安装', 'Finish running tasks and save your files, then restart to install') }
    if (installing) return { ok: false, error: pick('正在准备安装', 'Installation is being prepared') }
    installing = true
    let scheduled = false
    let backup: BackupSummary | null = null
    try {
      try {
        backup = await runBackup()
        state.error = undefined
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const answer = await dialog.showMessageBox({
          type: 'warning',
          title: pick('安装前备份失败', 'Pre-install backup failed'),
          message: pick('这次更新前的自动备份没有完成，还要现在安装吗？', 'The automatic backup before this update did not finish. Install anyway?'),
          detail: pick(`原因：${reason}\n\n没有备份就安装，更新后出问题时无法用本次备份恢复。`, `Reason: ${reason}\n\nWithout a backup, a problem after updating cannot be recovered from this backup.`),
          buttons: [pick('继续安装', 'Install anyway'), pick('取消', 'Cancel')],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        if (answer.response !== 0) {
          state.error = pick('安装前自动备份失败，已取消安装', 'The pre-install backup failed; installation was canceled')
          return { ok: false, error: state.error }
        }
      }
      if (busy()) {
        state.error = pick('备份期间有新任务开始，已取消这次重启安装', 'A task started during the backup; this restart was canceled')
        return { ok: false, error: state.error }
      }
      manualInstall = backup ? { reason: 'backed-up', backup } : { reason: 'accepted-without-backup' }
      scheduled = true
      setTimeout(() => {
        if (busy()) {
          installing = false
          manualInstall = null
          state.phase = 'downloaded'
          state.error = pick('备份之后又有任务开始，暂时不重启安装；等任务结束后再点安装', 'A task started after the backup; not restarting to install yet. Try again when the task finishes')
          return
        }
        state.error = undefined
        installing = false
        autoUpdater.quitAndInstall(true, true)
      }, 300)
      return { ok: true, ...(backup ? { backup } : {}) }
    } finally {
      if (!scheduled) installing = false
    }
  })

  const startupInstall = async (): Promise<void> => {
    launchPending = undefined
    installing = true
    let scheduled = false
    try {
      const summary = await runBackup().catch(() => null)
      if (!summary || busy() || state.phase !== 'downloaded') return
      manualInstall = { reason: 'backed-up', backup: summary }
      scheduled = true
      autoUpdater.quitAndInstall(true, true)
    } finally {
      if (!scheduled) installing = false
    }
  }

  prefsLoaded = readPrefs().then(() => {
    if (prefs.pending === state.current) {
      delete prefs.pending
      void savePrefs()
    }
    launchPending = prefs.pending
    state.automatic = prefs.automatic !== false
    autoUpdater.autoInstallOnAppQuit = false
    if (!app.isPackaged) return
    if (state.automatic) void check()
    setInterval(() => { if (state.automatic) void check() }, BACKGROUND_CHECK_MS).unref()
  })
  return { prepareAutomaticInstallOnQuit, cancelAutomaticInstallPreparation }
}
