import type { MessageKey } from '../../i18n'

export type SnoozePresetId = 'in-1h' | 'tonight' | 'tomorrow-morning' | 'next-monday'

export interface SnoozeOption {
  id: SnoozePresetId
  until: number
  labelKey: MessageKey
}

export interface Snoozable {
  snoozedUntil?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const EVENING_HOUR = 18
const MORNING_HOUR = 9
const TIMER_MARGIN_MS = 1000

export const MAX_SNOOZE_TIMER_MS = 2_147_000_000

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

export function pickSnoozeOption(id: string, now: number): SnoozeOption | undefined {
  return resolveSnoozeOptions(now).find((option) => option.id === id)
}

export function isSnoozed(session: Snoozable, now: number): boolean {
  return typeof session.snoozedUntil === 'number' && session.snoozedUntil > now
}

export function wakingSessions<T extends Snoozable>(sessions: readonly T[], now: number): T[] {
  return sessions.filter((session) => typeof session.snoozedUntil === 'number' && session.snoozedUntil <= now)
}

export function activeSessions<T extends Snoozable>(sessions: readonly T[], now: number): T[] {
  return sessions.filter((session) => !isSnoozed(session, now))
}

export function snoozedSessions<T extends Snoozable>(sessions: readonly T[], now: number): T[] {
  return sessions
    .filter((session) => isSnoozed(session, now))
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0))
}

export function nextSnoozeWake(sessions: readonly Snoozable[], now: number): number | null {
  let next: number | null = null
  for (const session of sessions) {
    if (!isSnoozed(session, now)) continue
    const until = session.snoozedUntil ?? 0
    if (next === null || until < next) next = until
  }
  return next
}

export function snoozeTimerDelay(wake: number | null, now: number): number | null {
  if (wake === null) return null
  return Math.min(Math.max(wake - now, 0) + TIMER_MARGIN_MS, MAX_SNOOZE_TIMER_MS)
}

export function localDateValue(at: number): string {
  const date = new Date(at)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function localTimeValue(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function customSnoozeUntil(date: string, time: string, now: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const wake = new Date(`${date}T${time}:00`)
  const at = wake.getTime()
  if (!Number.isFinite(at)) return null
  if (localDateValue(at) !== date || localTimeValue(at) !== time) return null
  return at > now ? at : null
}

export function formatSnoozeWake(until: number, now: number, lang: string): string {
  const sameDay = startOfLocalDay(until).getTime() === startOfLocalDay(now).getTime()
  return new Date(until).toLocaleString(lang, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(sameDay ? {} : { weekday: 'short' })
  })
}
