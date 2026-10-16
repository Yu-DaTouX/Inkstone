/**
 * 「切回 v2 界面」的共享逻辑（原 SettingsPanelV3 的既有行为，保持逐字一致）。
 *
 * 只在用户点击时执行：环境变量固定时按钮禁用并说明原因；先保存设置成功，
 * 再整窗重载；保存失败时留在原页并显错，不假装切换成功。
 */
import { useState } from 'react'
import type { Lang } from '../../../i18n'
import { settingsText } from '../settings-text'

export interface SwitchToV2 {
  /** 本次由环境变量固定为 v3，切换不生效 */
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
