import { useStore } from '../../state/store'
import type { TFunc } from '../../i18n'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function importSessionBundles(t: TFunc, filePaths: readonly string[]): Promise<void> {
  const store = useStore.getState()
  let last = ''
  for (const filePath of filePaths) {
    try {
      const result = await window.yan.sessionTransfer.importSession(filePath)
      if (result.ok && result.path) last = result.path
      else if (!result.cancelled) store.notify('error', result.error || t('rail.transferFailed'))
    } catch (error) {
      store.notify('error', describe(error))
    }
  }
  if (!last) return
  await store.refreshSessions()
  store.notify('info', t('rail.importDone'))
  await store.switchSession(last)
}
