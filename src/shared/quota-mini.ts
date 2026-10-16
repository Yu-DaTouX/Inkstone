import type { QuotaWindow } from './ipc'

export const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

export function money(v: number, cur?: string): string {
  const code = (cur ?? 'USD').toUpperCase()
  if (code === 'PERCENT') return `${v.toFixed(1)}%`
  const sym = CURRENCY_SYMBOL[code]
  return sym ? `${sym}${v.toFixed(2)}` : `${v.toFixed(2)} ${code}`
}

export interface CompactQuotaWindow {
  window: QuotaWindow
  label: string
}

export function quotaCompactWindows(windows: QuotaWindow[]): CompactQuotaWindow[] {
  const hour = windows.find(
    (w) => /小时|\bhours?\b|\b\d+\s*h\b/i.test(w.label) || w.id === 'fiveHour' || w.id === 'primary'
  )
  const week = windows.find(
    (w) => w.id === 'weekly' || w.id === 'secondary' || /每周|本周|weekly|\bweek\b/i.test(w.label)
  )
  const month = windows.find(
    (w) => w.id === 'monthly' || /本月|月度|monthly|\bmonth\b/i.test(w.label)
  )
  if (hour) {
    const match = hour.label.match(/(\d+)\s*(?:小时|hours?|h)/i)
    const digits =
      match?.[1] ??
      (hour.label.includes('五') || hour.id === 'fiveHour' || hour.id === 'primary' ? '5' : undefined)
    const hourLabel = digits ? `${digits}h` : hour.label
    return [{ window: hour, label: hourLabel }, ...(week ? [{ window: week, label: '周' }] : [])]
  }
  return [
    ...(week ? [{ window: week, label: '周' }] : []),
    ...(month ? [{ window: month, label: '月' }] : [])
  ]
}

export function windowPct(window: QuotaWindow, digits: 0 | 1 = 0): number | null {
  if (!(window.total > 0)) return null
  return Number(((window.used / window.total) * 100).toFixed(digits))
}
