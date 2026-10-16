import { previewOffice } from '../office/office-service'
import type { IpcRegistrar } from './registrar'

export function registerOfficeIpc(ipc: IpcRegistrar, resolveCwd: (requested: unknown) => Promise<string>): void {
  const { handle } = ipc
  handle('yan:office:preview', async (path: string, cwd?: string) => previewOffice(String(path ?? ''), await resolveCwd(cwd)))
}
