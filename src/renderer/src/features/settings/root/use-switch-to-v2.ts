import { useState } from 'react'
import type { Lang } from '../../../i18n'
import { settingsText } from '../settings-text'

export interface SwitchToV2 {
  env: boolean
  busy: boolean
  error: string | null
  switchToV2: () => Promise<void>
}

export function useSwitchToV2(lang: Lang): SwitchToV2 {
  const text = settingsText(lang)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const env = Boolean(window.yan.uiVersionEnv)

  const switchToV2 = async (): Promise<void> => {
    if (env || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.yan.patchSettings({ uiVersion: 'v2' })
      window.location.reload()
    } catch {
      setError(text.uiVersionFailed)
      setBusy(false)
    }
  }

  return { env, busy, error, switchToV2 }
}
