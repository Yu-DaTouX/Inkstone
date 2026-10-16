/**
 * 设置 → 上下文（v3，WP-42）。
 *
 * 迁移 v2 设置里的 NativeContextTab 能力，只换 v3 控件：
 *   · 自动压缩开关与上限（开关与「立即压缩」直接调 pi 原生能力）；
 *   · 省略较早大段工具输出的开关与起点（执行在随包扩展 context-trim.js）；
 *   · 当前会话的上下文占用展示。
 *
 * 复用现有 store 字段与动作（`settings` / `session` / `stats` / `patchSettings` /
 * `setAutoCompaction` / `compact`）与 `shared/context-limits.ts` 的档位，不新增 IPC 或设置字段。
 */
import type { ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, Switch } from '../../../ui'
import {
  AUTO_COMPACT_STEPS,
  autoCompactAt,
  CONTEXT_TRIM_STEPS,
  DEFAULT_AUTO_COMPACT_TOKENS,
  DEFAULT_CONTEXT_TRIM_TOKENS
} from '../../../../../shared/context-limits'
import { settingsText } from '../settings-text'
import { Segmented, SettingsRow } from '../root/controls'

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

export function ContextSettings(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const contextWindow = useStore((s) => s.stats?.contextUsage?.contextWindow) ?? 0
  const contextTokens = useStore((s) => s.stats?.contextUsage?.tokens) ?? null
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
  const windowText = contextWindow > 0 ? kTokens(contextWindow) : text.contextUnknown
  const usedText = contextTokens !== null ? kTokens(contextTokens) : text.contextUnknown

  return (
    <section className="settings-section" aria-label={text.sectionContext} data-testid="v3-context-settings">
      <p className="settings-note" role="note">
        {text.contextNote}
      </p>

      <dl className="settings-stats">
        <div className="settings-stat">
          <dt>{text.contextUsed}</dt>
          <dd data-testid="v3-ctx-used">{usedText}</dd>
        </div>
        <div className="settings-stat">
          <dt>{text.contextWindowLabel}</dt>
          <dd data-testid="v3-ctx-window">{windowText}</dd>
        </div>
      </dl>

      <div className="settings-rows">
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

        {autoEnabled ? (
          <SettingsRow label={text.contextCompactAt} description={compactAtText} block>
            <Segmented
              label={text.contextCompactAt}
              value={String(compactAtValue)}
              options={COMPACT_OPTIONS}
              onChange={(value) => void patchSettings({ autoCompactTokens: Number(value) })}
            />
          </SettingsRow>
        ) : null}

        <SettingsRow label={text.contextTrim} description={text.contextTrimDesc}>
          <Switch
            aria-label={text.contextTrim}
            isSelected={trimOn}
            onChange={(on) => void patchSettings({ contextTrim: on })}
          />
        </SettingsRow>

        {trimOn ? (
          <SettingsRow label={text.contextTrimAt} block>
            <Segmented
              label={text.contextTrimAt}
              value={String(trimAtValue)}
              options={TRIM_OPTIONS}
              onChange={(value) => void patchSettings({ contextTrimTokens: Number(value) })}
            />
          </SettingsRow>
        ) : null}

        <SettingsRow label={text.contextCompactNow}>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={!available || busy}
            data-testid="v3-ctx-compact-now"
            onPress={() => void compact()}
          >
            {text.contextCompactNow}
          </Button>
        </SettingsRow>
      </div>
    </section>
  )
}
