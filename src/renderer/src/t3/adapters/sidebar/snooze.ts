import { useMemo } from 'react'
import { useI18n } from '../../../i18n'
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from '../../internal/thread-settled'

export function useSnoozePresets(open: boolean, now = Date.now()): SnoozePreset[] {
  const { lang } = useI18n()
  return useMemo(() => (open ? resolveSnoozePresets(now, lang) : []), [open, now, lang])
}

export function useSnoozeWakeLabel(): (snoozedUntil: string) => string {
  const { lang } = useI18n()
  return (snoozedUntil: string) => snoozeWakeLabel(snoozedUntil, Date.now(), lang)
}
