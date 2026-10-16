import { useStore } from '../../../state/store'
import { useUiV3 } from '../../../state/ui-v3'

export interface SettingsRequest {
  view: string
  at: number
  revision: number
}

let current: SettingsRequest | null = null
const listeners = new Set<() => void>()

export function subscribeSettingsRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSettingsRequest(): SettingsRequest | null {
  return current
}

function record(view: string, revision: number): void {
  current = { view, at: Date.now(), revision }
  if (useUiV3.getState().route.name !== 'settings') {
    useUiV3.getState().navigate({ name: 'settings' })
  }
  for (const listener of listeners) listener()
}

let installed = false
let uninstallStore: (() => void) | null = null

export function installSettingsDeepLink(): void {
  if (installed) return
  installed = true

  let lastRevision = useStore.getState().settingsRequestRevision
  let lastTab = useStore.getState().settingsTab
  let lastOpen = useStore.getState().settingsOpen
  let recordedRevision = -1

  uninstallStore = useStore.subscribe((state) => {
    const revision = state.settingsRequestRevision
    const tab = state.settingsTab ?? ''
    const open = state.settingsOpen

    const revisionChanged = revision !== lastRevision
    const fieldsChanged = tab !== lastTab || open !== lastOpen
    lastRevision = revision
    lastTab = tab
    lastOpen = open

    if (revisionChanged) {
      if (revision === recordedRevision) return
      recordedRevision = revision
      record(tab, revision)
      return
    }

    if (!fieldsChanged || !open) return
    record(tab, revision)
  })
}

export function resetSettingsDeepLinkForTest(): void {
  uninstallStore?.()
  uninstallStore = null
  installed = false
  current = null
  listeners.clear()
}
