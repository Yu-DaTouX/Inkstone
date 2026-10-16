import type { IpcRegistrar } from './registrar'
import { changeConsentEntry, listConsentViews } from '../consent-store'

export function registerConsentIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
  handle('yan:consent:list', () => listConsentViews())
  handle('yan:consent:change', async (key: unknown, action: unknown) => {
    if (typeof key !== 'string' || (action !== 'always-ask' && action !== 'allow-auto' && action !== 'forget')) return listConsentViews()
    await changeConsentEntry(key, action)
    return listConsentViews()
  })
}
