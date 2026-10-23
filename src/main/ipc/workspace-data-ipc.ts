import { app, dialog, type BrowserWindow } from 'electron'
import type { IpcRegistrar } from './registrar'
import { createDataBackup, verifyDataBackup } from '../data-backup'
import { restoreDataBackup } from '../data-restore'
import { launchRestoredData } from '../data-restore-launch'
import { getSettings } from '../settings'
import { SESSIONS_DIR } from '../sessions'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import type { BackupAction, BackupResult, BackupSummary } from '../../shared/data-backup'

export function registerWorkspaceDataIpc(ipc: IpcRegistrar, window: () => BrowserWindow | null): void {
  let busy = false
  let restored: BackupSummary | null = null
  ipc.handle('yan:backup', async (action: BackupAction): Promise<BackupResult> => {
    if (busy) return { ok: false, error: 'Backup operation already running' }
    const win = window()
    if (!win || !['create', 'verify', 'restore', 'open-restored'].includes(action)) return { ok: false, cancelled: true }
    busy = true
    try {
      if (action === 'open-restored') {
        if (!restored) return { ok: false, error: 'Restore a backup before opening its data' }
        await launchRestoredData(restored.path, process.execPath, app.isPackaged ? undefined : app.getAppPath())
        return { ok: true, summary: restored }
      }
      const en = (await getSettings()).lang === 'en-US'
      const selected = await dialog.showOpenDialog(win, {
        title: action === 'create' ? (en ? 'Choose where to save the backup' : '选择备份保存位置') : (en ? 'Choose a backup folder' : '选择备份文件夹'),
        properties: action === 'create' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true }
      if (action === 'restore') {
        const checked = await verifyDataBackup(selected.filePaths[0])
        const confirmation = await dialog.showMessageBox(win, {
          type: 'question',
          title: en ? 'Restore to an independent folder' : '恢复到独立目录',
          message: en ? 'Restore this backup without changing your current data?' : '恢复这份备份，保留当前数据不变？',
          detail: en
            ? `${checked.files} files. Choose a parent folder next. Inkstone creates a new directory and does not overwrite anything. Credentials and project files are not included. You can open the restored data in a separate window afterward; it uses no inherited service credentials, starts with remote access off and the default permission mode, and requires signing in again.`
            : `${checked.files} 个文件。接下来选择存放位置，砚会新建独立目录，不覆盖现有数据。备份不含凭证及项目文件。完成后可另开窗口查看恢复数据；新窗口不继承服务凭证，远程访问默认关闭，权限恢复为默认档位，需要重新登录模型服务。`,
          buttons: en ? ['Restore', 'Cancel'] : ['恢复', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        if (confirmation.response !== 0) return { ok: false, cancelled: true }
        const target = await dialog.showOpenDialog(win, {
          title: en ? 'Choose where to create the restored data folder' : '选择恢复数据的存放位置',
          properties: ['openDirectory', 'createDirectory']
        })
        if (target.canceled || !target.filePaths[0]) return { ok: false, cancelled: true }
        restored = await restoreDataBackup(checked.path, target.filePaths[0], [PI_AGENT_DIR, SESSIONS_DIR, YAN_DIR])
        return { ok: true, summary: restored }
      }
      const summary = action === 'create'
        ? await createDataBackup(selected.filePaths[0], SESSIONS_DIR, YAN_DIR)
        : await verifyDataBackup(selected.filePaths[0])
      return { ok: true, summary }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally { busy = false }
  })
}
