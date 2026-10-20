import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  PiCacheWarming,
  PiNativeSettings,
  PiProjectTrustDefault,
  PiShareDestination
} from '../../../../../shared/ipc'
import { useI18n, useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { levelLabel } from '../../../patterns/ThinkingBadge'
import { Button, ListBoxItem, Notice, Select, Switch } from '../../../ui'
import { SettingsGroup, SettingsRow, Segmented, type SegmentedOption } from '../root/controls'
import { piNativeText, type PiNativeText } from './pi-native-text'

const RETRY_COUNTS = [1, 3, 5, 10]
const RETRY_DELAYS = [1000, 2000, 5000, 10_000]
const IDLE_TIMEOUTS = [30_000, 60_000, 120_000, 300_000, 0]
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface PiNativeSettingsState {
  settings: PiNativeSettings | null
  error: string
  patch: (patch: Partial<PiNativeSettings>) => Promise<void>
}

export function usePiNativeSettings(text: PiNativeText): PiNativeSettingsState {
  const [settings, setSettings] = useState<PiNativeSettings | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void window.yan
      .piNativeSettings()
      .then((result) => {
        if (!alive.current) return
        if (result.settings) setSettings(result.settings)
        setError(result.ok ? '' : result.error || text.loadFailed)
      })
      .catch(() => {
        if (alive.current) setError(text.loadFailed)
      })
    return () => {
      alive.current = false
    }
  }, [text.loadFailed])

  const patch = useCallback(
    async (next: Partial<PiNativeSettings>): Promise<void> => {
      try {
        const result = await window.yan.setPiNativeSettings(next)
        if (!alive.current) return
        if (result.ok) {
          setSettings(result.settings)
          setError('')
        } else {
          setError(result.error || text.saveFailed)
        }
      } catch {
        if (alive.current) setError(text.saveFailed)
      }
    },
    [text.saveFailed]
  )

  return { settings, error, patch }
}

function withCurrent(values: number[], current: number): number[] {
  return values.includes(current) ? values : [...values, current].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
}

function durationLabel(text: PiNativeText, ms: number): string {
  if (ms === 0) return text.idleOff
  if (ms >= 60_000 && ms % 60_000 === 0) return text.minutes(ms / 60_000)
  return text.seconds(Math.round(ms / 100) / 10)
}

function numberOptions(values: number[], label: (n: number) => string, prefix: string): SegmentedOption<string>[] {
  return values.map((value) => ({ value: String(value), label: label(value), testId: `${prefix}-${value}` }))
}

function PiNativeError({ error }: { error: string }): ReactElement | null {
  return error ? (
    <Notice tone="fail" compact>
      {error}
    </Notice>
  ) : null
}

export function PiRetryDetailRows({
  state,
  text,
  disabled
}: {
  state: PiNativeSettingsState
  text: PiNativeText
  disabled: boolean
}): ReactElement | null {
  const settings = state.settings
  if (!settings) return null
  return (
    <>
      <SettingsRow nested settingId="session-retry-count" label={text.retryCount} description={text.retryCountDesc}>
        <Segmented
          label={text.retryCount}
          value={String(settings.retryMaxRetries)}
          disabled={disabled}
          options={numberOptions(withCurrent(RETRY_COUNTS, settings.retryMaxRetries), text.retryTimes, 'v3-pi-retry-count')}
          onChange={(value) => void state.patch({ retryMaxRetries: Number(value) })}
        />
      </SettingsRow>
      <SettingsRow nested settingId="session-retry-delay" label={text.retryDelay} description={text.retryDelayDesc}>
        <Segmented
          label={text.retryDelay}
          value={String(settings.retryBaseDelayMs)}
          disabled={disabled}
          options={numberOptions(withCurrent(RETRY_DELAYS, settings.retryBaseDelayMs), (ms) => durationLabel(text, ms), 'v3-pi-retry-delay')}
          onChange={(value) => void state.patch({ retryBaseDelayMs: Number(value) })}
        />
      </SettingsRow>
    </>
  )
}

function ModelThinkingLevels({ state, text }: { state: PiNativeSettingsState; text: PiNativeText }): ReactElement {
  const t = useT()
  const models = useStore((s) => s.models)
  const levels = useMemo(() => state.settings?.modelThinkingLevels ?? {}, [state.settings])
  const [model, setModel] = useState('')
  const [level, setLevel] = useState('high')
  const nameOf = (key: string): string => {
    const hit = models.find((m) => `${m.provider}/${m.id}` === key)
    return hit?.name || key
  }
  const choices = models.filter((m) => !levels[`${m.provider}/${m.id}`])
  const write = (next: Record<string, string>): Promise<void> => state.patch({ modelThinkingLevels: next })
  const entries = Object.entries(levels).sort(([a], [b]) => a.localeCompare(b))

  return (
    <SettingsGroup
      title={text.thinking}
      description={entries.length ? text.thinkingDesc : `${text.thinkingDesc} ${text.thinkingEmpty}`}
      settingId="models-thinking-levels"
    >
      {entries.map(([key, value]) => (
        <SettingsRow key={key} label={nameOf(key)} description={key}>
          <div className="settings-actions">
            <Select
              aria-label={`${text.thinkingLevel} · ${nameOf(key)}`}
              selectedKey={value}
              onSelectionChange={(next) => void write({ ...levels, [key]: String(next) })}
              data-testid="v3-pi-thinking-level"
            >
              {THINKING_LEVELS.map((item) => (
                <ListBoxItem key={item} id={item}>
                  {levelLabel(t, item)}
                </ListBoxItem>
              ))}
            </Select>
            <Button
              variant="danger"
              onPress={() => {
                const next = { ...levels }
                delete next[key]
                void write(next)
              }}
              data-testid="v3-pi-thinking-remove"
            >
              {text.thinkingRemove}
            </Button>
          </div>
        </SettingsRow>
      ))}
      <SettingsRow label={text.thinkingAdd} description={models.length ? undefined : text.thinkingNoModels}>
        <div className="settings-actions">
          <Select
            aria-label={text.thinkingModel}
            placeholder={text.thinkingModel}
            selectedKey={model || null}
            isDisabled={!choices.length}
            onSelectionChange={(next) => setModel(String(next ?? ''))}
            data-testid="v3-pi-thinking-model"
          >
            {choices.map((m) => (
              <ListBoxItem key={`${m.provider}/${m.id}`} id={`${m.provider}/${m.id}`}>
                {m.name || m.id}
              </ListBoxItem>
            ))}
          </Select>
          <Select
            aria-label={text.thinkingLevel}
            selectedKey={level}
            onSelectionChange={(next) => setLevel(String(next ?? 'high'))}
            data-testid="v3-pi-thinking-new-level"
          >
            {THINKING_LEVELS.map((item) => (
              <ListBoxItem key={item} id={item}>
                {levelLabel(t, item)}
              </ListBoxItem>
            ))}
          </Select>
          <Button
            variant="secondary"
            isDisabled={!model}
            onPress={() => {
              void write({ ...levels, [model]: level }).then(() => setModel(''))
            }}
            data-testid="v3-pi-thinking-add"
          >
            {text.thinkingAdd}
          </Button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}

export function PiSessionGroups({ state, text }: { state: PiNativeSettingsState; text: PiNativeText }): ReactElement | null {
  const settings = state.settings
  if (!settings) return <PiNativeError error={state.error} />
  const cacheOptions: SegmentedOption<PiCacheWarming>[] = [
    { value: 'off', label: text.cacheOff, testId: 'v3-pi-cache-off' },
    { value: 'streaming', label: text.cacheStreaming, testId: 'v3-pi-cache-streaming' },
    { value: 'idle', label: text.cacheIdle, testId: 'v3-pi-cache-idle' }
  ]
  return (
    <>
      <SettingsGroup title={text.requests}>
        <SettingsRow settingId="session-idle-timeout" label={text.idleTimeout} description={text.idleTimeoutDesc}>
          <Segmented
            label={text.idleTimeout}
            value={String(settings.httpIdleTimeoutMs)}
            options={numberOptions(withCurrent(IDLE_TIMEOUTS, settings.httpIdleTimeoutMs), (ms) => durationLabel(text, ms), 'v3-pi-idle')}
            onChange={(value) => void state.patch({ httpIdleTimeoutMs: Number(value) })}
          />
        </SettingsRow>
        <SettingsRow settingId="session-cache-warming" label={text.cacheWarming} description={text.cacheWarmingDesc}>
          <Segmented
            label={text.cacheWarming}
            value={settings.cacheWarming}
            options={cacheOptions}
            onChange={(value) => void state.patch({ cacheWarming: value })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={text.images}>
        <SettingsRow settingId="session-images-resize" label={text.imagesAutoResize} description={text.imagesAutoResizeDesc}>
          <Switch
            aria-label={text.imagesAutoResize}
            isSelected={settings.imagesAutoResize}
            onChange={(on) => void state.patch({ imagesAutoResize: on })}
            data-testid="v3-pi-images-resize"
          />
        </SettingsRow>
        <SettingsRow settingId="session-images-block" label={text.imagesBlock} description={text.imagesBlockDesc}>
          <Switch
            aria-label={text.imagesBlock}
            isSelected={settings.imagesBlockImages}
            onChange={(on) => void state.patch({ imagesBlockImages: on })}
            data-testid="v3-pi-images-block"
          />
        </SettingsRow>
      </SettingsGroup>

      <p className="settings-note" role="note">
        {text.sessionEffectNote}
      </p>
      <PiNativeError error={state.error} />
    </>
  )
}

export function PiThinkingLevelsGroup(): ReactElement | null {
  const { lang } = useI18n()
  const text = piNativeText(lang)
  const state = usePiNativeSettings(text)
  if (!state.settings) return <PiNativeError error={state.error} />
  return (
    <>
      <ModelThinkingLevels state={state} text={text} />
      <PiNativeError error={state.error} />
    </>
  )
}

export function PiProjectTrustGroup({ title }: { title?: string }): ReactElement | null {
  const { lang } = useI18n()
  const text = piNativeText(lang)
  const state = usePiNativeSettings(text)
  if (!state.settings) return <PiNativeError error={state.error} />
  const options: SegmentedOption<PiProjectTrustDefault>[] = [
    { value: 'ask', label: text.trustAsk, testId: 'v3-pi-trust-ask' },
    { value: 'always', label: text.trustAlways, testId: 'v3-pi-trust-always' },
    { value: 'never', label: text.trustNever, testId: 'v3-pi-trust-never' }
  ]
  return (
    <SettingsGroup title={title ?? text.trust}>
      <SettingsRow settingId="security-project-trust" label={text.trust} description={`${text.trustDesc} ${text.effectNote}`}>
        <Segmented
          label={text.trust}
          value={state.settings.defaultProjectTrust}
          options={options}
          onChange={(value) => void state.patch({ defaultProjectTrust: value })}
        />
      </SettingsRow>
      <PiNativeError error={state.error} />
    </SettingsGroup>
  )
}

export function PiShareDestinationGroup({ title }: { title?: string }): ReactElement | null {
  const { lang } = useI18n()
  const text = piNativeText(lang)
  const state = usePiNativeSettings(text)
  if (!state.settings) return <PiNativeError error={state.error} />
  const options: SegmentedOption<PiShareDestination>[] = [
    { value: 'auto', label: text.shareAuto, testId: 'v3-pi-share-auto' },
    { value: 'gist', label: text.shareGist, testId: 'v3-pi-share-gist' },
    { value: 'radius', label: text.shareRadius, testId: 'v3-pi-share-radius' }
  ]
  return (
    <SettingsGroup title={title ?? text.share}>
      <SettingsRow settingId="data-share-destination" label={text.share} description={`${text.shareDesc} ${text.effectNote}`}>
        <Segmented
          label={text.share}
          value={state.settings.sessionShareDestination}
          options={options}
          onChange={(value) => void state.patch({ sessionShareDestination: value })}
        />
      </SettingsRow>
      <PiNativeError error={state.error} />
    </SettingsGroup>
  )
}
