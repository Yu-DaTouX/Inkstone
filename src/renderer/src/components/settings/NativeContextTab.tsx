import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Segmented, SettingRow, StepSlider, Switch } from '../ui'
import {
  AUTO_COMPACT_STEPS,
  autoCompactAt,
  CONTEXT_TRIM_STEPS,
  DEFAULT_AUTO_COMPACT_TOKENS,
  DEFAULT_CONTEXT_TRIM_TOKENS
} from '../../../../shared/context-limits'

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`
const COMPACT_VALUES = AUTO_COMPACT_STEPS.map(String)
const TRIM_VALUES = CONTEXT_TRIM_STEPS.map(String)

/**
 * 上下文：压缩本身是 pi 原生的（开关与立即压缩直接调 pi）；
 * 砚只补两样——自动压缩上限（跟随 pi 的开关）与省略旧工具输出，执行在随包扩展 context-trim.js。
 */
export function NativeContextTab() {
  const t = useT()
  const session = useStore(s => s.session)
  const settings = useStore(s => s.settings)
  const patchSettings = useStore(s => s.patchSettings)
  const contextWindow = useStore(s => s.stats?.contextUsage?.contextWindow) ?? 0
  const compact = useStore(s => s.compact)
  const setAutoCompaction = useStore(s => s.setAutoCompaction)
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const available = !!session?.sessionId

  const compactAtValue = settings?.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
  const effective = autoCompactAt(compactAtValue, contextWindow)
  const trimOn = settings?.contextTrim !== false
  const trimAtValue = settings?.contextTrimTokens ?? DEFAULT_CONTEXT_TRIM_TOKENS

  return (
    <div data-testid="ctx-native-settings">
      <SettingRow name={t('ctx.autoCompact')} desc={available ? undefined : t('ctx.nativeUnavailable')}>
        <Switch label={t('ctx.autoCompact')} checked={session?.autoCompactionEnabled === true} disabled={!available || session?.autoCompactionEnabled === undefined} onChange={on => void setAutoCompaction(on)} />
      </SettingRow>
      {session?.autoCompactionEnabled !== false ? (
        <SettingRow
          col
          ctlClassName="ctx-compact-ctl"
          name={t('ctx.compactAt')}
          desc={
            <span data-testid="ctx-compact-at-now">
              {effective < compactAtValue
                ? t('ctx.compactAtClamped', { n: kTokens(compactAtValue), w: kTokens(contextWindow), e: kTokens(effective) })
                : t('ctx.compactAtNow', { n: kTokens(compactAtValue) })}
            </span>
          }
        >
          <StepSlider
            values={COMPACT_VALUES}
            value={String(compactAtValue)}
            onChange={v => void patchSettings({ autoCompactTokens: Number(v) })}
            label={t('ctx.compactAt')}
            format={v => kTokens(Number(v))}
            colorOf={v => (autoCompactAt(Number(v), contextWindow) < Number(v) ? 'var(--fg-mute)' : 'var(--accent)')}
            testId="ctx-compact-at"
            stopTestId={v => `ctx-compact-at-${v}`}
          />
        </SettingRow>
      ) : null}
      <SettingRow name={t('ctx.trim')} desc={t('ctx.trimDesc')}>
        <Switch label={t('ctx.trim')} checked={trimOn} onChange={on => void patchSettings({ contextTrim: on })} testId="ctx-trim" />
      </SettingRow>
      {trimOn ? (
        <SettingRow name={t('ctx.trimAt')}>
          <Segmented
            size="sm"
            label={t('ctx.trimAt')}
            value={String(trimAtValue)}
            onChange={v => void patchSettings({ contextTrimTokens: Number(v) })}
            options={TRIM_VALUES.map(v => ({ value: v, label: kTokens(Number(v)), testId: `ctx-trim-at-${v}` }))}
            testId="ctx-trim-at"
          />
        </SettingRow>
      ) : null}
      <SettingRow name={t('status.compact')}>
        <Button icon="compact" disabled={!available || busy} onClick={() => void compact()}>{t('status.compact')}</Button>
      </SettingRow>
    </div>
  )
}
