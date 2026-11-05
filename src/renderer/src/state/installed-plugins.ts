import { useEffect } from 'react'
import { create } from 'zustand'

export const VOICE_PLUGIN = 'voice-input'

interface InstalledPlugins {
  installed: Record<string, boolean>
  mark(id: string, installed: boolean): void
}

export const useInstalledPlugins = create<InstalledPlugins>((set) => ({
  installed: {},
  mark: (id, installed) => set((s) => (s.installed[id] === installed ? s : { installed: { ...s.installed, [id]: installed } }))
}))

export function useVoicePluginInstalled(): boolean {
  const installed = useInstalledPlugins((s) => s.installed[VOICE_PLUGIN])
  useEffect(() => {
    if (installed !== undefined) return
    void window.yan.voice
      .available()
      .then((value) => useInstalledPlugins.getState().mark(VOICE_PLUGIN, value))
      .catch(() => undefined)
  }, [installed])
  return installed === true
}
