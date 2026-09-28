/**
 * 办公文件预览与对比的 IPC 适配（`yan:office:*`）。
 * 相对路径按调用方给的会话目录（缺省为设置里的当前目录）解析，校验链与文件预览相同。
 */
import { compareOffice, previewOffice } from '../office/office-service'
import type { IpcRegistrar } from './registrar'

export function registerOfficeIpc(ipc: IpcRegistrar, defaultCwd: () => Promise<string>): void {
  const { handle } = ipc
  const cwdOf = async (requested: unknown): Promise<string> =>
    typeof requested === 'string' && requested.trim() ? requested : defaultCwd()
  handle('yan:office:preview', async (path: string, cwd?: string) => previewOffice(String(path ?? ''), await cwdOf(cwd)))
  handle('yan:office:compare', async (path: string, cwd?: string) => compareOffice(String(path ?? ''), await cwdOf(cwd)))
}
