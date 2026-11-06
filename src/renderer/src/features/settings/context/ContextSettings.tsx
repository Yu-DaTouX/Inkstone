import type { CSSProperties, ReactElement } from 'react'
import { useCompactionInfo } from './use-compaction-info'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, Switch } from '../../../ui'
import { contextUsageSummary } from '../../workbench/context-pane-view'
import { AUTO_COMPACT_STEPS, autoCompactAt, DEFAULT_AUTO_COMPACT_TOKENS } from '../../../../../shared/context-limits'
import { settingsText } from '../settings-text'
import { Segmented, SettingsGroup, SettingsReveal, SettingsRow } from '../root/controls'
import { useTweenedNumber } from '../root/use-tweened-number'
import type { PiNativeSettingsState } from '../general/PiNativeSettings'

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

const COMPACT_OPTIONS = AUTO_COMPACT_STEPS.map((value) => ({
  value: String(value),
  label: kTokens(value),
  testId: `v3-ctx-compact-${value}`
}))

const percentOf = (value: number, total: number): number => Math.max(0, Math.min(100, (value / total) * 100))

interface UsageMarker {
  key: string
  at: number
  label: string
}

function ContextUsageMeter({
  tokens,
  windowSize,
  windowText,
  usedLabel,
  unknownText,
  markers,
  warnAt
}: {
  tokens: number | null
  windowSize: number
  windowText: string
  usedLabel: string
  unknownText: string
  markers: UsageMarker[]
  warnAt: number | null
}): ReactElement {
  const shown = useTweenedNumber(tokens ?? 0)
  const measurable = windowSize > 0 && tokens !== null
  const percent = measurable ? percentOf(tokens, windowSize) : 0
  const level = measurable && warnAt !== null && tokens >= warnAt ? 'ask' : 'ok'

  return (
    <div className="settings-usage" data-level={level}>
      <div className="settings-usage__head">
        <span className="settings-usage__value" data-testid="v3-ctx-used">
          {tokens !== null ? kTokens(shown) : unknownText}
        </span>
        <span className="settings-usage__window" data-testid="v3-ctx-window">
          / {windowText}
        </span>
        {measurable ? <span className="settings-usage__pct">{percent.toFixed(1)}%</span> : null}
      </div>
      {windowSize > 0 ? (
        <div
          className="settings-usage__track"
          role="meter"
          aria-label={usedLabel}
          aria-valuemin={0}
          aria-valuemax={windowSize}
          aria-valuenow={tokens ?? 0}
          aria-valuetext={tokens !== null ? `${kTokens(tokens)} / ${windowText}` : unknownText}
        >
          <span className="settings-usage__fill" style={{ width: `${percent}%` }} />
          {markers.map((marker) => (
            <span
              key={marker.key}
              className="settings-usage__mark"
              data-mark={marker.key}
              style={{ '--at': `${percentOf(marker.at, windowSize)}%` } as CSSProperties}
              title={`${marker.label} · ${kTokens(marker.at)}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ContextSettings({ piNative, lede }: { piNative: PiNativeSettingsState; lede?: string }): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const stats = useStore((s) => s.stats)
  const usage = contextUsageSummary(session, stats)
  const contextWindow = usage.windowSize
  const contextTokens = usage.known ? usage.tokens : null
  const compact = useStore((s) => s.compact)
  const setAutoCompaction = useStore((s) => s.setAutoCompaction)

  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const available = !!session?.sessionId
  const sessionAuto = available ? session?.autoCompactionEnabled : undefined
  const globalAuto = piNative.settings?.compactionEnabled
  const autoEnabled = (sessionAuto ?? globalAuto) === true
  const autoKnown = (sessionAuto ?? globalAuto) !== undefined
  const toggleAutoCompaction = (on: boolean): void => {
    if (sessionAuto !== undefined) void setAutoCompaction(on)
    else void piNative.patch({ compactionEnabled: on })
  }

  const compactAtValue = settings?.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
  const effective = autoCompactAt(compactAtValue, contextWindow)
  const info = useCompactionInfo(session?.cwd ?? '', contextWindow, compactAtValue)
  const actualAt = info?.cappedByInkstone ? Math.min(effective, info.threshold) : effective
  const compactAtDescription = [
    contextWindow > 0 && actualAt < compactAtValue ? text.contextCompactAtActual.replace('{e}', kTokens(actualAt)) : '',
    info?.projectIgnored ? text.contextProjectIgnored : ''
  ].filter(Boolean).join(' · ') || undefined

  const windowText = contextWindow > 0 ? `${usage.windowAssumed ? '~' : ''}${kTokens(contextWindow)}` : text.contextUnknown

  const compactOptions = COMPACT_OPTIONS.map((option) =>
    contextWindow > 0 && Number(option.value) > contextWindow ? { ...option, disabled: true } : option
  )

  const markers: UsageMarker[] = []
  if (autoEnabled) markers.push({ key: 'compact', at: effective, label: text.contextCompactAt })

  return (
    <SettingsGroup title={text.groupSessionContext} description={lede} testId="v3-context-settings" className="settings-context">
      <SettingsRow block settingId="session-compact-now" label={text.contextUsed}>
        <ContextUsageMeter
          tokens={contextTokens}
          windowSize={contextWindow}
          windowText={windowText}
          usedLabel={text.contextUsed}
          unknownText={text.contextUnknown}
          markers={markers}
          warnAt={autoEnabled ? effective : null}
        />
        <Button
          variant="secondary"
          isDisabled={!available || busy || contextTokens === 0}
          data-testid="v3-ctx-compact-now"
          onPress={() => void compact()}
        >
          {text.contextCompactNow}
        </Button>
      </SettingsRow>

      <SettingsRow settingId="session-auto-compact" label={text.contextAutoCompact}>
        <Switch
          aria-label={text.contextAutoCompact}
          isSelected={autoEnabled}
          isDisabled={!autoKnown}
          onChange={toggleAutoCompaction}
          data-testid="v3-ctx-auto-compact"
        />
      </SettingsRow>
      <SettingsReveal open={autoEnabled}>
        <SettingsRow nested settingId="session-compact-at" label={text.contextCompactAt} description={compactAtDescription}>
          <Segmented
            label={text.contextCompactAt}
            value={String(compactAtValue)}
            options={compactOptions}
            onChange={(value) => void patchSettings({ autoCompactTokens: Number(value) })}
          />
        </SettingsRow>
      </SettingsReveal>
    </SettingsGroup>
  )
}
