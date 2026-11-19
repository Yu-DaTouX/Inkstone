import { app, BrowserWindow, dialog, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startupInstallDue, type AppUpdateStatus, type AppUpdateWhatsNew } from '../shared/app-update'
import type { BackupSummary } from '../shared/data-backup'
import type { IpcRegistrar } from './ipc/registrar'
import { createUpdateAutoBackup } from './data-backup'
import { askSkipLargeParts } from './backup-skip-prompt'
import { logMainEvent } from './main-log'
import { BACKUP_PART_LABELS } from '../shared/data-backup'
import { SESSIONS_DIR } from './sessions'
import { YAN_DIR } from './paths'
import { atomicWriteFile } from './atomic-write'
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

type InstallExitSource = 'manual' | 'startup'

export interface AppUpdateControl {
  prepareInstallOnQuit(options?: AutomaticInstallPreparationOptions): Promise<AutomaticInstallPreparation>
  cancelInstallPreparation(): void
  installAfterShutdown(): boolean
}

function messageWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.find((win) => !win.isDestroyed()) ?? null
}

export function registerAppUpdate(
  ipc: IpcRegistrar,
  busy: () => boolean,
  requestInstallExit: (source: InstallExitSource) => Promise<boolean>,
  backup?: (interactive?: boolean) => Promise<BackupSummary>
): AppUpdateControl {
  const runBackup = backup ?? (async (interactive?: boolean) => {
    const input = { userData: app.getPath('userData'), sessions: SESSIONS_DIR, yan: YAN_DIR }
    const summary = await createUpdateAutoBackup(input, interactive ? { confirmSkip: (info) => askSkipLargeParts(messageWindow(), info, 'update') } : {})
    if (summary.skipped?.length) {
      const parts = summary.skipped.map((item) => `${pick(BACKUP_PART_LABELS[item.part].zh, BACKUP_PART_LABELS[item.part].en)}(${item.files})`).join(', ')
      logMainEvent(pick('更新前备份', 'Pre-update backup'), pick(`备份超出上限，已跳过：${parts}；上一份完整的自动备份已保留`, `The backup exceeded the limit and skipped: ${parts}; the previous complete automatic backup was kept`))
    }
    return summary
  })
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
    const next = prefsWrite.catch(() => undefined).then(() => atomicWriteFile(preferences, JSON.stringify(prefs)))
    prefsWrite = next
    return next
  }
  const savePrefs = (): Promise<void> => writePrefs().catch(() => undefined)
  let preparing: Promise<AutomaticInstallPreparation> | null = null
  let prepareAbort: AbortController | null = null
  let intent: { source: InstallExitSource; backup?: BackupSummary } | null = null
  let approval: { restart: boolean; requiresAutomatic: boolean } | null = null
  const requestRestart = async (source: InstallExitSource, backup?: BackupSummary): Promise<boolean> => {
    const next = { source, backup }
    intent = next
    let accepted = false
    try {
      accepted = await requestInstallExit(source)
      return accepted
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (!accepted && intent === next) intent = null
    }
  }
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
  const prepareInstallOnQuit = (input: AutomaticInstallPreparationOptions = {}): Promise<AutomaticInstallPreparation> => {
    if (preparing) {
      const controller = prepareAbort
      if (input.signal?.aborted) controller?.abort()
      else input.signal?.addEventListener('abort', () => controller?.abort(), { once: true })
      return preparing
    }
    const controller = new AbortController()
    prepareAbort = controller
    if (input.signal) {
      if (input.signal.aborted) controller.abort()
      else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const aborted = (): boolean => controller.signal.aborted
    const requested = intent
    const requiresAutomatic = requested?.source !== 'manual'
    approval = null
    preparing = (async (): Promise<AutomaticInstallPreparation> => {
      if (aborted()) return { install: false, reason: 'aborted' }
      if (state.phase !== 'downloaded') return { install: false, reason: 'no-update' }
      if (!app.isPackaged || (requiresAutomatic && !state.automatic)) return { install: false, reason: 'disabled' }
      if (requested) return requested.backup
        ? { install: true, reason: 'backed-up', backup: requested.backup }
        : { install: true, reason: 'accepted-without-backup' }
      try {
        const summary = await runBackup()
        if (aborted()) return { install: false, reason: 'aborted' }
        if (!state.automatic) return { install: false, reason: 'disabled' }
        state.error = undefined
        return { install: true, reason: 'backed-up', backup: summary }
      } catch (error) {
        if (aborted()) return { install: false, reason: 'aborted' }
        if (!state.automatic) return { install: false, reason: 'disabled' }
        const reason = error instanceof Error ? error.message : String(error)
        const proceed = await askWithoutBackup(reason)
        if (aborted()) return { install: false, reason: 'aborted' }
        if (!state.automatic) return { install: false, reason: 'disabled' }
        if (proceed) return { install: true, reason: 'accepted-without-backup' }
        state.error = pick('安装前自动备份失败，这次退出不安装更新', 'The pre-install backup failed; the update will not be installed on this quit')
        return { install: false, reason: 'cancelled' }
      }
    })()
      .then((result): AutomaticInstallPreparation => {
        if (aborted() || intent !== requested) return { install: false, reason: 'aborted' }
        if (result.install) approval = { restart: requested !== null, requiresAutomatic }
        return result
      })
      .catch((error) => {
        if (!aborted()) state.error = pick(`退出前准备安装失败：${error instanceof Error ? error.message : String(error)}`, `Preparing the install before quitting failed: ${error instanceof Error ? error.message : String(error)}`)
        return { install: false, reason: aborted() ? 'aborted' as const : 'failed' as const }
      })
      .finally(() => {
        if (prepareAbort === controller) prepareAbort = null
        preparing = null
      })
    return preparing
  }
  const cancelInstallPreparation = (): void => {
    prepareAbort?.abort()
    intent = null
    approval = null
  }
  const installAfterShutdown = (): boolean => {
    const prepared = approval
    cancelInstallPreparation()
    if (!prepared || state.phase !== 'downloaded' || (prepared.requiresAutomatic && !state.automatic)) return false
    let failed = false
    const onError = (): void => { failed = true }
    autoUpdater.once('error', onError)
    try {
      autoUpdater.quitAndInstall(true, prepared.restart)
      return !failed
    } catch (error) {
      console.warn('[update] could not launch installer', error)
      return false
    } finally {
      autoUpdater.removeListener('error', onError)
    }
  }
  const launchedAt = Date.now()
  let launchPending: string | undefined
  autoUpdater.on('update-downloaded', (info?: { version?: string }) => {
    state.phase = 'downloaded'
    state.percent = 100
    cancelInstallPreparation()
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
        backup = await runBackup(true)
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
      scheduled = true
      setTimeout(() => {
        if (busy()) {
          installing = false
          state.error = pick('备份之后又有任务开始，暂时不重启安装；等任务结束后再点安装', 'A task started after the backup; not restarting to install yet. Try again when the task finishes')
          return
        }
        if (state.phase !== 'downloaded') {
          installing = false
          return
        }
        state.error = undefined
        void requestRestart('manual', backup ?? undefined).then((accepted) => { if (!accepted) installing = false })
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
      if (!summary || !state.automatic || busy() || state.phase !== 'downloaded') return
      scheduled = await requestRestart('startup', summary)
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
    if (!app.isPackaged) return
    if (state.automatic) void check()
    setInterval(() => { if (state.automatic) void check() }, BACKGROUND_CHECK_MS).unref()
  })
  return { prepareInstallOnQuit, cancelInstallPreparation, installAfterShutdown }
}
