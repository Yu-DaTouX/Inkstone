export const FIAT_CURRENCIES = ['USD', 'CNY', 'EUR', 'JPY', 'HKD', 'GBP'] as const
export type FiatCurrency = typeof FIAT_CURRENCIES[number]
export const YUANSHI = 'YUANSHI'
export type UsageCurrency = FiatCurrency | typeof YUANSHI
export const USAGE_CURRENCIES: readonly UsageCurrency[] = [...FIAT_CURRENCIES, YUANSHI]

export const DEFAULT_USD_RATES: Readonly<Record<FiatCurrency, number>> = { USD: 1, CNY: 7.1, EUR: 0.92, JPY: 150, HKD: 7.8, GBP: 0.79 }
export const YUANSHI_PER_CNY = 10

export interface UsageCurrencySettings {
  currency: UsageCurrency
  rates?: Partial<Record<FiatCurrency, number>>
}

export const DEFAULT_USAGE_CURRENCY: UsageCurrencySettings = { currency: 'USD' }

const SYMBOL: Record<FiatCurrency, string> = { USD: '$', CNY: '¥', EUR: '€', JPY: 'JP¥', HKD: 'HK$', GBP: '£' }

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e6
}

export function normalizeUsageCurrency(value: unknown): UsageCurrencySettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const currency = USAGE_CURRENCIES.includes(raw.currency as UsageCurrency) ? raw.currency as UsageCurrency : 'USD'
  const rates: Partial<Record<FiatCurrency, number>> = {}
  if (raw.rates && typeof raw.rates === 'object' && !Array.isArray(raw.rates)) {
    for (const code of FIAT_CURRENCIES) {
      const rate = (raw.rates as Record<string, unknown>)[code]
      if (code !== 'USD' && validRate(rate) && rate !== DEFAULT_USD_RATES[code]) rates[code] = rate
    }
  }
  if (currency === 'USD' && !Object.keys(rates).length) return undefined
  return Object.keys(rates).length ? { currency, rates } : { currency }
}

export function usdRate(settings: UsageCurrencySettings | undefined, code: FiatCurrency): number {
  if (code === 'USD') return 1
  const rate = settings?.rates?.[code]
  return validRate(rate) ? rate : DEFAULT_USD_RATES[code]
}

export function convertUsd(usd: number, settings: UsageCurrencySettings | undefined): number {
  const currency = settings?.currency ?? 'USD'
  if (currency === YUANSHI) return usd * usdRate(settings, 'CNY') * YUANSHI_PER_CNY
  return usd * usdRate(settings, currency)
}

function decimals(value: number, currency: UsageCurrency): number {
  const abs = Math.abs(value)
  if (currency === 'JPY' || currency === YUANSHI) return abs > 0 && abs < 10 ? 1 : 0
  return abs > 0 && abs < 1 ? 3 : 2
}

export function formatMoney(usd: number, settings: UsageCurrencySettings | undefined, lang: string = 'zh-CN'): string {
  const currency = settings?.currency ?? 'USD'
  const value = convertUsd(Number.isFinite(usd) ? usd : 0, settings)
  const digits = decimals(value, currency)
  const number = value.toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (currency === YUANSHI) return `${number} ${lang === 'en-US' ? 'Primogems' : '原石'}`
  return `${SYMBOL[currency]}${number}`
}

export function currencyLabel(currency: UsageCurrency, lang: string = 'zh-CN'): string {
  if (currency === YUANSHI) return lang === 'en-US' ? 'Primogems (1 = ¥0.1)' : '原石（1 原石 = 0.1 元）'
  return `${currency} ${SYMBOL[currency]}`
}
