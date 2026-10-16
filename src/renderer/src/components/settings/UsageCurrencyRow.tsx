import { useEffect, useState } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { SettingRow } from '../ui'
import {
  currencyLabel,
  formatMoney,
  normalizeUsageCurrency,
  USAGE_CURRENCIES,
  usdRate,
  YUANSHI,
  type FiatCurrency,
  type UsageCurrency
} from '../../../../shared/currency'

export function UsageCurrencyRow() {
  const t = useT()
  const { lang } = useI18n()
  const current = useStore((s) => s.settings?.usageCurrency)
  const patchSettings = useStore((s) => s.patchSettings)
  const currency = current?.currency ?? 'USD'
  const rateCode: FiatCurrency | null = currency === YUANSHI ? 'CNY' : currency === 'USD' ? null : currency
  const rate = rateCode ? usdRate(current, rateCode) : 1
  const [draft, setDraft] = useState(String(rate))
  useEffect(() => setDraft(String(rate)), [rate, rateCode])

  const save = (next: { currency?: UsageCurrency; rate?: number }): void => {
    const rates = { ...(current?.rates ?? {}) }
    if (rateCode && next.rate !== undefined) rates[rateCode] = next.rate
    void patchSettings({ usageCurrency: normalizeUsageCurrency({ currency: next.currency ?? currency, rates }) })
  }
  const commitRate = (): void => {
    const value = Number(draft)
    if (Number.isFinite(value) && value > 0 && value < 1e6) save({ rate: value })
    else setDraft(String(rate))
  }

  return (
    <SettingRow name={t('set.usageCurrency')} desc={t('set.usageCurrencyDesc', { sample: formatMoney(1, current, lang) })}>
      <div className="pkg-install-row">
        <select className="ui-input" data-testid="set-usage-currency" aria-label={t('set.usageCurrency')} value={currency}
          onChange={(event) => save({ currency: event.target.value as UsageCurrency })}>
          {USAGE_CURRENCIES.map((code) => <option key={code} value={code}>{currencyLabel(code, lang)}</option>)}
        </select>
        {rateCode ? <input className="ui-input" data-testid="set-usage-rate" inputMode="decimal" value={draft}
          aria-label={t('set.usageRate', { code: rateCode })} title={t('set.usageRate', { code: rateCode })}
          onChange={(event) => setDraft(event.target.value)} onBlur={commitRate}
          onKeyDown={(event) => { if (event.key === 'Enter') commitRate() }} /> : null}
      </div>
    </SettingRow>
  )
}
