import type { MessageKey } from '../../i18n'

export type SnoozePresetId = 'in-1h' | 'tonight' | 'tomorrow-morning' | 'next-monday'

export interface SnoozeOption {
  id: SnoozePresetId
  until: number
  labelKey: MessageKey
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const EVENING_HOUR = 18
const MORNING_HOUR = 9

export function startOfLocalDay(at: number): Date {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day
}

function addLocalDays(day: Date, days: number): Date {
  const next = new Date(day.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function hourOfLocalDay(day: Date, hour: number): number {
  const next = new Date(day.getTime())
  next.setHours(hour, 0, 0, 0)
  return next.getTime()
}

export function resolveSnoozeOptions(now: number): SnoozeOption[] {
  const day = startOfLocalDay(now)
  const evening = hourOfLocalDay(day, EVENING_HOUR)
  const morning = hourOfLocalDay(addLocalDays(day, 1), MORNING_HOUR)
  const monday = hourOfLocalDay(addLocalDays(day, (8 - day.getDay()) % 7 || 7), MORNING_HOUR)
  const candidates: SnoozeOption[] = [
    { id: 'in-1h', until: now + HOUR_MS, labelKey: 'rail.snoozeInHour' },
    evening > now
      ? { id: 'tonight', until: evening, labelKey: 'rail.snoozeTonight' }
      : { id: 'tonight', until: morning, labelKey: 'rail.snoozeTomorrow' },
    { id: 'tomorrow-morning', until: morning, labelKey: 'rail.snoozeTomorrow' },
    { id: 'next-monday', until: monday, labelKey: 'rail.snoozeNextMonday' }
  ]
  const options: SnoozeOption[] = []
  for (const option of candidates) {
    if (option.until <= now) continue
    if (options.some((item) => item.until === option.until)) continue
    options.push(option)
  }
  return options.sort((a, b) => a.until - b.until)
}

const wakeFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatSnoozeWake(until: number, now: number, lang: string): string {
  const sameDay = startOfLocalDay(until).getTime() === startOfLocalDay(now).getTime()
  const key = `${lang}:${sameDay ? 'time' : 'weekday-time'}`
  let formatter = wakeFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(lang, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(sameDay ? {} : { weekday: 'short' })
    })
    wakeFormatters.set(key, formatter)
  }
  return formatter.format(until)
}
