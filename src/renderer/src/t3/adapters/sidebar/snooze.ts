import { useMemo } from 'react'
import { useI18n } from '../../../i18n'
import { pickSnoozePreset, resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from '../../internal/thread-settled'

export function useSnoozePresets(open: boolean): SnoozePreset[] {
  const { lang } = useI18n()
  const now = Date.now()
  return useMemo(() => (open ? resolveSnoozePresets(now, lang) : []), [open, now, lang])
}

export function usePickSnoozePreset(shown: readonly SnoozePreset[]): (id: string) => SnoozePreset | undefined {
  const { lang } = useI18n()
  return (id: string) => pickSnoozePreset(shown, id, Date.now(), lang)
}

export function useSnoozeWakeLabel(): (snoozedUntil: string) => string {
  const { lang } = useI18n()
  return (snoozedUntil: string) => snoozeWakeLabel(snoozedUntil, Date.now(), lang)
}
