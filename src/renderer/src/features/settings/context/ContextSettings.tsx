import type { CSSProperties, ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, SegmentedControl, Switch } from '../../../ui'
import { contextUsageSummary } from '../../workbench/context-pane-view'
import {
  AUTO_COMPACT_STEPS,
  autoCompactAt,
  CONTEXT_TRIM_STEPS,
  DEFAULT_AUTO_COMPACT_TOKENS,
  DEFAULT_CONTEXT_TRIM_TOKENS
} from '../../../../../shared/context-limits'
import { settingsText } from '../settings-text'
import { SettingsGroup, SettingsReveal, SettingsRow } from '../root/controls'
import { useTweenedNumber } from '../root/use-tweened-number'

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

const COMPACT_OPTIONS = AUTO_COMPACT_STEPS.map((value) => ({
  value: String(value),
  label: kTokens(value),
  testId: `v3-ctx-compact-${value}`
}))
const TRIM_OPTIONS = CONTEXT_TRIM_STEPS.map((value) => ({
  value: String(value),
  label: kTokens(value),
  testId: `v3-ctx-trim-${value}`
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
  const level = measurable && warnAt !== null && tokens >= warnAt ? 'warn' : 'ok'

  return (
    <div className="settings-usage" data-level={level}>
      <div className="settings-usage__head">
        <span className="settings-usage__label">{usedLabel}</span>
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
      {markers.length > 0 ? (
        <ul className="settings-usage__legend">
          {markers.map((marker) => (
            <li key={marker.key} data-mark={marker.key}>
              {marker.label} <b>{kTokens(marker.at)}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function ContextSettings(): ReactElement {
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
  const autoEnabled = session?.autoCompactionEnabled === true
  const autoKnown = session?.autoCompactionEnabled !== undefined

  const compactAtValue = settings?.autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
  const effective = autoCompactAt(compactAtValue, contextWindow)
  const compactAtText =
    contextWindow > 0 && effective < compactAtValue
      ? text.contextCompactAtClamped.replace('{n}', kTokens(compactAtValue)).replace('{e}', kTokens(effective))
      : text.contextCompactAtNow.replace('{n}', kTokens(compactAtValue))

  const trimOn = settings?.contextTrim !== false
  const trimAtValue = settings?.contextTrimTokens ?? DEFAULT_CONTEXT_TRIM_TOKENS
  const windowText = contextWindow > 0 ? `${usage.windowAssumed ? '~' : ''}${kTokens(contextWindow)}` : text.contextUnknown

  const markers: UsageMarker[] = []
  if (trimOn) markers.push({ key: 'trim', at: trimAtValue, label: text.contextTrimAt })
  if (autoEnabled) markers.push({ key: 'compact', at: effective, label: text.contextCompactAt })

  return (
    <section className="settings-section" aria-label={text.sectionContext} data-testid="v3-context-settings">
      <p className="settings-section__lede">{text.contextNote}</p>

      <div className="settings-usage-card">
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
          size="sm"
          isDisabled={!available || busy}
          data-testid="v3-ctx-compact-now"
          onPress={() => void compact()}
        >
          {text.contextCompactNow}
        </Button>
      </div>

      <SettingsGroup label={text.contextAutoCompact}>
        <SettingsRow
          label={text.contextAutoCompact}
          description={available && autoKnown ? undefined : text.contextUnavailable}
        >
          <Switch
            aria-label={text.contextAutoCompact}
            isSelected={autoEnabled}
            isDisabled={!available || !autoKnown}
            onChange={(on) => void setAutoCompaction(on)}
          />
        </SettingsRow>
        <SettingsReveal open={autoEnabled}>
          <SettingsRow label={text.contextCompactAt} description={compactAtText}>
            <SegmentedControl
              label={text.contextCompactAt}
              value={String(compactAtValue)}
              options={COMPACT_OPTIONS}
              onChange={(value) => void patchSettings({ autoCompactTokens: Number(value) })}
            />
          </SettingsRow>
        </SettingsReveal>
      </SettingsGroup>

      <SettingsGroup label={text.contextTrim}>
        <SettingsRow label={text.contextTrim} description={text.contextTrimDesc}>
          <Switch
            aria-label={text.contextTrim}
            isSelected={trimOn}
            onChange={(on) => void patchSettings({ contextTrim: on })}
          />
        </SettingsRow>
        <SettingsReveal open={trimOn}>
          <SettingsRow label={text.contextTrimAt}>
            <SegmentedControl
              label={text.contextTrimAt}
              value={String(trimAtValue)}
              options={TRIM_OPTIONS}
              onChange={(value) => void patchSettings({ contextTrimTokens: Number(value) })}
            />
          </SettingsRow>
        </SettingsReveal>
      </SettingsGroup>
    </section>
  )
}
