import type { QuotaWindow } from '../shared/ipc'
import { WINDOW_DURATION } from '../shared/quota-forecast'

export interface CommandCodeWindow {
  used?: number
  cap?: number
  exceeded?: boolean
  resetAt?: number
}

export interface CommandCodeCredits {
  credits?: {
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
  }
  windowLimits?: {
    limited?: boolean
    exceeded?: string
    fiveHour?: CommandCodeWindow
    weekly?: CommandCodeWindow
  }
}

export function commandCodeWindows(credits: CommandCodeCredits, periodEnd?: number): QuotaWindow[] {
  const wl = credits.windowLimits ?? {}
  const windows: QuotaWindow[] = []
  const add = (id: string, label: string, durationMs: number, w?: CommandCodeWindow): void => {
    const cap = Number(w?.cap)
    if (!w || !Number.isFinite(cap) || cap <= 0) return
    windows.push({
      id,
      label,
      used: Number(w.used ?? 0),
      total: cap,
      resetAt: typeof w.resetAt === 'number' ? w.resetAt : undefined,
      exceeded: w.exceeded === true,
      durationMs
    })
  }
  add('fiveHour', '5 小时', WINDOW_DURATION.fiveHour, wl.fiveHour)
  add('weekly', '每周', WINDOW_DURATION.week, wl.weekly)

  const planCredits = Number(wl.weekly?.cap) * 2
  const monthlyRemaining = Number(credits.credits?.monthlyCredits)
  if (Number.isFinite(planCredits) && planCredits > 0 && Number.isFinite(monthlyRemaining)) {
    const monthlyTotal = Math.max(planCredits, monthlyRemaining)
    const usedMonthly = Math.max(0, monthlyTotal - monthlyRemaining)
    windows.push({
      id: 'monthly',
      label: '本月',
      used: usedMonthly,
      total: monthlyTotal,
      resetAt: periodEnd,
      exceeded: monthlyRemaining <= 0,
      estimated: true,
      durationMs: WINDOW_DURATION.month
    })
  }
  return windows
}
