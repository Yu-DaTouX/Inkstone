import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { ListBoxItem, Select, TextField } from '../../ui'
import {
  currencyLabel,
  DEFAULT_USD_RATES,
  formatMoney,
  normalizeUsageCurrency,
  USAGE_CURRENCIES,
  usdRate,
  YUANSHI,
  type FiatCurrency,
  type UsageCurrency as Currency
} from '../../../../shared/currency'
import type { SettingsText } from '../settings/settings-text'

export function UsageCurrency({ text }: { text: SettingsText }): ReactElement {
  const { lang } = useI18n()
  const current = useStore((s) => s.settings?.usageCurrency)
  const patchSettings = useStore((s) => s.patchSettings)
  const currency = current?.currency ?? 'USD'
  const rateCode: FiatCurrency | null = currency === YUANSHI ? 'CNY' : currency === 'USD' ? null : currency
  const rate = rateCode ? usdRate(current, rateCode) : 1
  const [draft, setDraft] = useState(String(rate))
  useEffect(() => setDraft(String(rate)), [rate, rateCode])

  const save = (next: { currency?: Currency; rate?: number }): void => {
    const rates = { ...(current?.rates ?? {}) }
    if (rateCode && next.rate !== undefined) rates[rateCode] = next.rate
    void patchSettings({ usageCurrency: normalizeUsageCurrency({ currency: next.currency ?? currency, rates }) })
  }

  const commitRate = (): void => {
    const value = Number(draft)
    if (Number.isFinite(value) && value > 0 && value < 1e6) save({ rate: value })
    else setDraft(String(rate))
  }

  const rateLabel = rateCode ? text.usageRate.replace('{code}', rateCode) : ''
  return (
    <section className="usage-page-currency" data-testid="v3-usage-currency">
      <div className="usage-page-currency-row">
        <div>
          <h2>{text.usageCurrency}</h2>
          <p>{text.usageCurrencyDesc}</p>
        </div>
        <div className="usage-page-currency-control"><Select aria-label={text.usageCurrency} selectedKey={currency} onSelectionChange={(key) => save({ currency: String(key) as Currency })}>
          {USAGE_CURRENCIES.map((code) => (
            <ListBoxItem key={code} id={code}>
              {currencyLabel(code, lang)}
            </ListBoxItem>
          ))}
        </Select></div>
      </div>
      {rateCode ? (
        <div className="usage-page-currency-row">
          <div>
            <h2>{rateLabel}</h2>
            <p>{text.usageRateDesc.replace('{default}', String(DEFAULT_USD_RATES[rateCode])).replace('{sample}', formatMoney(1, current, lang))}</p>
          </div>
          <div className="usage-page-currency-control"><TextField
            aria-label={rateLabel}
            value={draft}
            inputMode="decimal"
            onChange={setDraft}
            onBlur={commitRate}
            onKeyDown={(event) => { if (event.key === 'Enter') commitRate() }}
            data-testid="v3-usage-rate"
          /></div>
        </div>
      ) : null}
    </section>
  )
}
