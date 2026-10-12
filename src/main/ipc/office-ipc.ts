/**
 * 办公文件预览的 IPC 适配（`yan:office:*`）。
 * 相对路径按调用方给的会话目录（缺省为设置里的当前目录）解析，校验链与文件预览相同。
 */
import { previewOffice } from '../office/office-service'
import type { IpcRegistrar } from './registrar'

export function registerOfficeIpc(ipc: IpcRegistrar, resolveCwd: (requested: unknown) => Promise<string>): void {
  const { handle } = ipc
  // 与文件树/文本预览共用宿主授权目录解析，不能把任意存在的 cwd 当预览根。
  handle('yan:office:preview', async (path: string, cwd?: string) => previewOffice(String(path ?? ''), await resolveCwd(cwd)))
}
