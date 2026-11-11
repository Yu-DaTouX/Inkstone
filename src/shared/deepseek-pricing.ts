import calendars from './china-public-holidays.json'

export type DeepSeekPricePeriod = 'peak' | 'offPeak' | 'unknown'

const holidayCalendars: Record<string, { holidays: string[][] }> = calendars

export function deepseekPricePeriod(at: number): DeepSeekPricePeriod {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  const day = date.getUTCDay()
  const hour = date.getUTCHours()
  if (day === 0 || day === 6 || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return 'offPeak'
  const calendar = holidayCalendars[String(date.getUTCFullYear())]
  if (!calendar) return 'unknown'
  const monthDay = date.toISOString().slice(5, 10)
  return calendar.holidays.some(([from, to]) => monthDay >= from && monthDay <= to) ? 'offPeak' : 'peak'
}
