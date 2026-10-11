import { dialog, type BrowserWindow } from 'electron'
import type { IpcRegistrar } from './registrar'
import { InteractionStore } from '../interaction-state'
import { createDataBackup, verifyDataBackup } from '../data-backup'
import { SESSIONS_DIR } from '../sessions'
import { YAN_DIR } from '../paths'
import type { BackupResult } from '../../shared/data-backup'

export function registerWorkspaceDataIpc(ipc: IpcRegistrar, window: () => BrowserWindow | null): void {
  const store = new InteractionStore()
  ipc.handle('yan:interactions:get', (session: string) => store.get(session))
  ipc.handle('yan:interactions:set', (session: string, key: string, value: string | null) => store.set(session, key, value))
  let busy = false
  ipc.handle('yan:backup', async (action: 'create' | 'verify'): Promise<BackupResult> => {
    if (busy) return { ok: false, error: 'Backup operation already running' }
    const win = window()
    if (!win || !['create', 'verify'].includes(action)) return { ok: false, cancelled: true }
    busy = true
    try {
      const selected = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true }
      const summary = action === 'create'
        ? await createDataBackup(selected.filePaths[0], SESSIONS_DIR, YAN_DIR)
        : await verifyDataBackup(selected.filePaths[0])
      return { ok: true, summary }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally { busy = false }
  })
}
