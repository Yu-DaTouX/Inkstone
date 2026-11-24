import type { WatchClient } from '../watch-client'
import type { IpcRegistrar } from './registrar'

export function registerWatchIpc(ipc: IpcRegistrar, client: () => WatchClient): void {
  const { handle } = ipc
  handle('yan:watch:join', (invite: string) => client().join(String(invite ?? '')))
  handle('yan:watch:list', async () => client().list())
  handle('yan:watch:refresh', async (id: string) => client().refresh(String(id ?? '')))
  handle('yan:watch:leave', (id: string) => client().leave(String(id ?? '')))
}
