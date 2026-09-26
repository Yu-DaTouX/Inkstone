/*
 * 额度摘要的纯派生（实施-20 U2）。
 *
 * 摘要栏与展开后的明细必须显示**同一批数**。以前两处各写一份格式化
 * （窗口值一处、主值一处），窄栏换行时容易出现「摘要 25%、明细 25.0%」
 * 这种看着不像同一个数的结果。这里只保留一份窗口选择与百分比派生，
 * 摘要与明细共用；文本长度差异（整数 / 一位小数）是刻意的，数字本身同源。
 */
import type { QuotaWindow } from './ipc'

/** 常用币种符号；没有的币种退回「9.92 CNY」这种写法（不猜符号） */
export const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

/**
 * 余额行只写一个数字 + 一个单位，不混排 `$` / 币种。
 *
 * `PERCENT` 是伪币种：ChatGPT 订阅的用量接口只给 used_percent，
 * 走这里时必须渲染成 `25.0%` 而不是 `$25.00`。
 */
export function money(v: number, cur?: string): string {
  const code = (cur ?? 'USD').toUpperCase()
  if (code === 'PERCENT') return `${v.toFixed(1)}%`
  const sym = CURRENCY_SYMBOL[code]
  return sym ? `${sym}${v.toFixed(2)}` : `${v.toFixed(2)} ${code}`
}

export interface CompactQuotaWindow {
  window: QuotaWindow
  /** 摘要栏用的短标签（`5h` / `周` / `月`） */
  label: string
}

/** 紧凑栏只显示接口实际返回的短周期组合，不推算缺失窗口。 */
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

/**
 * 窗口百分比（同一派生：摘要与明细都调它）。
 * 摘要用 0 位小数（短），明细用 1 位（准）；数字来自同一次除法。
 */
export function windowPct(window: QuotaWindow, digits: 0 | 1 = 0): number | null {
  if (!(window.total > 0)) return null
  return Number(((window.used / window.total) * 100).toFixed(digits))
}
