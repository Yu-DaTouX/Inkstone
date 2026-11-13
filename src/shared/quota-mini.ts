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
