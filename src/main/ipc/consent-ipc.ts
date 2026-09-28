/**
 * 普通工具自动调用依据的 IPC 适配（`yan:consent:*`）：查看每类操作的答复统计，设为始终询问 / 恢复 / 清空。
 */
import type { IpcRegistrar } from './registrar'
import { changeConsentEntry, listConsentViews } from '../consent-store'

export function registerConsentIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
  /* ---- 普通工具的自动调用依据：查看与调整 ---- */
  handle('yan:consent:list', () => listConsentViews())
  handle('yan:consent:change', async (key: unknown, action: unknown) => {
    if (typeof key !== 'string' || (action !== 'always-ask' && action !== 'allow-auto' && action !== 'forget')) return listConsentViews()
    await changeConsentEntry(key, action)
    return listConsentViews()
  })
}
