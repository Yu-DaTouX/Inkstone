import type { AppSettings } from '../../../../shared/ipc'
import { uiText } from '../../i18n/ui-text'
import { useStore, type Store } from '../store'
import { applyBrowserVisibility } from './browser'
import { pushNotice, type SliceContext } from './shared'

let settingsBlockerRelease: (() => void) | null = null

let settingsPatchQueue: Promise<unknown> = Promise.resolve()

let rightPanelPatchSeq = 0

async function persistSettingsPatch(patch: Partial<AppSettings>): Promise<AppSettings> {
  const operation = settingsPatchQueue.then(async () => {
    const next = await window.yan.patchSettings(patch)
    useStore.setState({ settings: next })
    return useStore.getState().settings ?? next
  })
  settingsPatchQueue = operation.catch(() => undefined)
  return operation
}

export type SettingsSlice = Pick<Store, 'settings' | 'settingsOpen' | 'settingsTab' | 'settingsRequestRevision' | 'maximized' | 'alwaysOnTop' | 'zoom' | 'setUiScale' | 'loadZoom' | 'patchSettings' | 'removeGuardAllowRoot' | 'setSettings' | 'applyServerSettings' | 'openSettings' | 'closeSettings' | 'toggleAlwaysOnTop' | 'setRightPanelOpen'>

export function createSettingsSlice({ set, get }: SliceContext): SettingsSlice {
  return {
  settings: null,
  settingsOpen: false,
  settingsTab: 'appearance',
  settingsRequestRevision: 0,
  maximized: false,
  alwaysOnTop: false,
  zoom: null,
  setUiScale: async (v) => {
    set({ zoom: await window.yan.setUiScale(v) })
    set({ settings: await window.yan.getSettings() })
  },
  loadZoom: async () => {
    try {
      set({ zoom: await window.yan.getZoom() })
    } catch {
    }
  },
  patchSettings: async (p) => {
    try {
      set({ settings: await persistSettingsPatch(p) })
    } catch (cause) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.settingsSaveFailed')) })
      throw cause
    }
  },
  removeGuardAllowRoot: async (path) => {
    try {
      set({ settings: await window.yan.removeGuardAllowRoot(path) })
    } catch (error) {
      set({ notices: pushNotice(get().notices, 'error', error instanceof Error ? error.message : String(error)) })
    }
  },
  setSettings: (s) => set({ settings: s }),
  applyServerSettings: (s) => {
    const operation = settingsPatchQueue.then(async () => {
      useStore.setState({ settings: s })
    })
    settingsPatchQueue = operation.catch(() => undefined)
  },
  openSettings: (tab) => {
    if (!settingsBlockerRelease) settingsBlockerRelease = get().acquireOverlayBlocker('settings')
    set({
      settingsOpen: true,
      settingsTab: tab ?? 'appearance',
      settingsRequestRevision: get().settingsRequestRevision + 1
    })
  },
  closeSettings: () => {
    set({ settingsOpen: false })
    settingsBlockerRelease?.()
    settingsBlockerRelease = null
  },
  toggleAlwaysOnTop: async () => {
    const next = !get().alwaysOnTop
    const previous = !next
    set({ alwaysOnTop: next })
    try {
      const real = await window.yan.win.setAlwaysOnTop(next)
      if (get().alwaysOnTop !== next) return
      set({ alwaysOnTop: real })
    } catch (error) {
      if (get().alwaysOnTop === next) set({ alwaysOnTop: previous })
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.alwaysOnTopFailed', { error: String(error) })) })
      return
    }
    set({
      notices: pushNotice(
        get().notices,
        'info',
        get().alwaysOnTop ? uiText('state.alwaysOnTop.on') : uiText('state.alwaysOnTop.off')
      )
    })
  },
  setRightPanelOpen: async (v) => {
    const request = ++rightPanelPatchSeq
    const s = get().settings
    const previous = s?.rightPanelOpen ?? true
    if (s) set({ settings: { ...s, rightPanelOpen: v } })
    applyBrowserVisibility(get)
    try {
      const next = await persistSettingsPatch({ rightPanelOpen: v })
      if (request === rightPanelPatchSeq) set({ settings: next })
    } catch (error) {
      if (request === rightPanelPatchSeq) set({ settings: get().settings ? { ...get().settings!, rightPanelOpen: previous } : get().settings })
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.savePanelVisibilityFailed', { error: String(error) })) })
    }
    applyBrowserVisibility(get)
  },
  }
}
