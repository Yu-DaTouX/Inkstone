import { useEffect, useState, type ReactElement } from 'react'
import type { PiRuntimePrefs, QueueMode } from '../../../../../shared/ipc'
import { effectiveAutoArchiveDays } from '../../../../../shared/session-archive'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { ListBoxItem, Select, Switch } from '../../../ui'
import { generalText } from './general-text'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Segmented } from '../root/controls'
import { settingsText } from '../settings-text'
import { ContextSettings } from '../context/ContextSettings'
import { PiRetryDetailRows, PiSessionGroups, usePiNativeSettings } from './PiNativeSettings'
import { piNativeText } from './pi-native-text'
import { UserAddressSetting } from './UserAddressSetting'

const ARCHIVE_OPTIONS = [0, 3, 7, 14, 30] as const
const RESPONSE_DETAILS = ['brief', 'standard', 'detailed'] as const
type ResponseDetailChoice = (typeof RESPONSE_DETAILS)[number]
const QUEUE_MODES: QueueMode[] = ['one-at-a-time', 'all']
const FOLLOW_SESSION = 'follow'

export function SessionSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const labels = settingsText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)

  const archiveDays = effectiveAutoArchiveDays(settings)
  const keepAwake = settings?.keepAwakeWhileWorking !== false
  const keepAwakeBattery = settings?.keepAwakeOnBattery !== false
  const checkpoints = settings?.checkpointsEnabled !== false
  const subagentNotify = settings?.subagentNotify !== false
  const loopAutoContinue = settings?.streamLoopAutoContinue !== false
  const promptSuggestions = settings?.promptSuggestions !== false
  const responseDetail: ResponseDetailChoice = settings?.responseDetail ?? 'standard'
  const responseDetailLabels: Record<ResponseDetailChoice, string> = {
    brief: text.responseDetailBrief,
    standard: text.responseDetailStandard,
    detailed: text.responseDetailDetailed
  }
  const models = useStore((s) => s.models)
  const subagentDefault = settings?.subagentDefaultModel
  const subagentModelKey = subagentDefault && subagentDefault !== 'follow' ? `${subagentDefault.provider}/${subagentDefault.id}` : FOLLOW_SESSION
  const session = useStore((s) => s.session)
  const autoRetry = useStore((s) => s.autoRetryEnabled)
  const setAutoRetry = useStore((s) => s.setAutoRetry)
  const setSteeringMode = useStore((s) => s.setSteeringMode)
  const setFollowUpMode = useStore((s) => s.setFollowUpMode)
  const [prefs, setPrefs] = useState<PiRuntimePrefs | null>(null)
  const [compression, setCompression] = useState<{ supported: boolean; files: number; savedBytes: number } | null>(null)
  const [compressing, setCompressing] = useState(false)
  const compressEnabled = settings?.compressArchivedSessions === true
  const runCompression = (run: boolean): void => {
    setCompressing(run)
    void window.yan.archivedCompression(run).then(setCompression).catch(() => undefined).finally(() => setCompressing(false))
  }
  const piText = piNativeText(lang)
  const piNative = usePiNativeSettings(piText)

  useEffect(() => {
    let alive = true
    if (compressEnabled) runCompression(true)
    else void window.yan.archivedCompression(false).then((next) => { if (alive) setCompression(next) }).catch(() => undefined)
    void window.yan.piRuntimePrefs().then((next) => {
      if (!alive) return
      setPrefs(next)
      useStore.setState({ autoRetryEnabled: next.autoRetry })
    })
    return () => {
      alive = false
    }
  }, [])

  const steeringMode = session?.steeringMode ?? prefs?.steeringMode ?? 'one-at-a-time'
  const followUpMode = session?.followUpMode ?? prefs?.followUpMode ?? 'one-at-a-time'
  const queueOptions = (prefix: string) =>
    QUEUE_MODES.map((value) => ({
      value,
      label: value === 'all' ? text.queueAll : text.queueOneAtATime,
      testId: `${prefix}-${value}`
    }))

  return (
    <section className="settings-section" data-testid="v3-session-settings">
      <ContextSettings piNative={piNative} lede={text.sessionContextLede} />

      <SettingsGroup title={labels.groupSessionGeneral}>
        <UserAddressSetting />
        <SettingsRow settingId="session-checkpoints" label={text.sessionCheckpoints} description={text.sessionCheckpointsDesc}>
          <Switch
            aria-label={text.sessionCheckpoints}
            isSelected={checkpoints}
            onChange={(on) => void patchSettings({ checkpointsEnabled: on })}
            data-testid="v3-session-checkpoints"
          />
        </SettingsRow>

        <SettingsRow settingId="session-prompt-suggestions" label={text.sessionPromptSuggestions} description={text.sessionPromptSuggestionsDesc}>
          <Switch
            aria-label={text.sessionPromptSuggestions}
            isSelected={promptSuggestions}
            onChange={(on) => void patchSettings({ promptSuggestions: on })}
            data-testid="v3-session-prompt-suggestions"
          />
        </SettingsRow>

        <SettingsRow settingId="session-response-detail" label={text.sessionResponseDetail} description={text.sessionResponseDetailDesc}>
          <Segmented
            label={text.sessionResponseDetail}
            value={responseDetail}
            options={RESPONSE_DETAILS.map((value) => ({
              value,
              label: responseDetailLabels[value],
              testId: `v3-session-response-detail-${value}`
            }))}
            onChange={(value) => void patchSettings({ responseDetail: value as ResponseDetailChoice })}
          />
        </SettingsRow>

        <SettingsRow settingId="session-keep-awake" label={text.sessionKeepAwake} description={text.sessionKeepAwakeDesc}>
          <Switch
            aria-label={text.sessionKeepAwake}
            isSelected={keepAwake}
            onChange={(on) => void patchSettings({ keepAwakeWhileWorking: on })}
            data-testid="v3-session-keep-awake"
          />
        </SettingsRow>
        <SettingsRow
          nested
          settingId="session-keep-awake-battery"
          label={text.sessionKeepAwakeBattery}
          description={keepAwake ? text.sessionKeepAwakeBatteryDesc : text.sessionKeepAwakeBatteryOff}
        >
          <Switch
            aria-label={text.sessionKeepAwakeBattery}
            isSelected={keepAwakeBattery}
            isDisabled={!keepAwake}
            onChange={(on) => void patchSettings({ keepAwakeOnBattery: on })}
            data-testid="v3-session-keep-awake-battery"
          />
        </SettingsRow>

        <SettingsRow settingId="session-auto-archive" label={text.sessionAutoArchive} description={text.sessionAutoArchiveDesc}>
          <Segmented
            label={text.sessionAutoArchive}
            value={String(archiveDays)}
            options={ARCHIVE_OPTIONS.map((value) => ({
              value: String(value),
              label: value === 0 ? text.archiveNever : text.archiveDays.replace('{n}', String(value)),
              testId: `v3-session-archive-${value}`
            }))}
            onChange={(value) => void patchSettings({ autoArchiveDays: Number(value) })}
          />
        </SettingsRow>
        <SettingsRow
          settingId="session-compress-archived"
          label={text.sessionCompress}
          description={compression && !compression.supported ? text.sessionCompressUnsupported : `${text.sessionCompressDesc} ${compressing ? text.sessionCompressRunning : compression && compression.files > 0 ? text.sessionCompressSaved.replace('{n}', String(compression.files)).replace('{size}', `${Math.round(compression.savedBytes / 1_048_576)} MB`) : compressEnabled && compression ? text.sessionCompressNone : ''}`.trim()}
        >
          <Switch
            aria-label={text.sessionCompress}
            isSelected={compressEnabled}
            isDisabled={!compression?.supported}
            onChange={(on) => {
              void patchSettings({ compressArchivedSessions: on }).then(() => { if (on) runCompression(true) }).catch(() => undefined)
            }}
            data-testid="v3-session-compress-archived"
          />
        </SettingsRow>
        <SettingsRow settingId="session-thinking-display" label={text.sessionThinkingDisplay} description={text.sessionThinkingDisplayDesc}>
          <Segmented
            label={text.sessionThinkingDisplay}
            value={settings?.thinkingDisplay === 'updates' ? 'updates' : 'summarized'}
            options={[
              { value: 'summarized', label: text.thinkingDisplaySummarized, testId: 'v3-session-thinking-summarized' },
              { value: 'updates', label: text.thinkingDisplayUpdates, testId: 'v3-session-thinking-updates' }
            ]}
            onChange={(value) => void patchSettings({ thinkingDisplay: value === 'updates' ? 'updates' : 'summarized' })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsAdvanced label={labels.advanced} testId="v3-session-advanced">
        <SettingsGroup title={text.sessionDelivery}>
          <SettingsRow settingId="session-steering-mode" label={text.sessionSteeringMode} description={text.sessionSteeringModeDesc}>
            <Segmented
              label={text.sessionSteeringMode}
              value={steeringMode}
              options={queueOptions('v3-session-steering')}
              onChange={(value) => void setSteeringMode(value as QueueMode)}
            />
          </SettingsRow>
          <SettingsRow settingId="session-follow-up-mode" label={text.sessionFollowUpMode} description={text.sessionFollowUpModeDesc}>
            <Segmented
              label={text.sessionFollowUpMode}
              value={followUpMode}
              options={queueOptions('v3-session-follow-up')}
              onChange={(value) => void setFollowUpMode(value as QueueMode)}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={labels.groupSessionSubagents}>
          <SettingsRow
            settingId="session-subagent-notify"
            label={text.sessionSubagentNotify}
            description={text.sessionSubagentNotifyDesc}
          >
            <Switch
              aria-label={text.sessionSubagentNotify}
              isSelected={subagentNotify}
              onChange={(on) => void patchSettings({ subagentNotify: on })}
              data-testid="v3-session-subagent-notify"
            />
          </SettingsRow>
          <SettingsRow settingId="session-subagent-model" label={text.sessionSubagentModel} description={text.sessionSubagentModelDesc}>
            <Select
              aria-label={text.sessionSubagentModel}
              selectedKey={subagentModelKey}
              onSelectionChange={(next) => {
                const key = String(next ?? FOLLOW_SESSION)
                const picked = models.find((item) => `${item.provider}/${item.id}` === key)
                void patchSettings(
                  picked
                    ? { subagentDefaultModel: { provider: picked.provider, id: picked.id, name: picked.name } }
                    : { subagentDefaultModel: 'follow', subagentModelForce: false }
                )
              }}
              data-testid="v3-session-subagent-model"
            >
              <ListBoxItem id={FOLLOW_SESSION}>{text.sessionSubagentModelFollow}</ListBoxItem>
              {models.map((item) => (
                <ListBoxItem key={`${item.provider}/${item.id}`} id={`${item.provider}/${item.id}`}>
                  {item.name || item.id}
                </ListBoxItem>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow
            nested
            settingId="session-subagent-model-force"
            label={text.sessionSubagentModelForce}
            description={text.sessionSubagentModelForceDesc}
          >
            <Switch
              aria-label={text.sessionSubagentModelForce}
              isSelected={settings?.subagentModelForce === true}
              isDisabled={subagentModelKey === FOLLOW_SESSION}
              onChange={(on) => void patchSettings({ subagentModelForce: on })}
              data-testid="v3-session-subagent-model-force"
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title={labels.groupSessionRetry}>
          <SettingsRow settingId="session-auto-retry" label={text.sessionAutoRetry} description={text.sessionAutoRetryDesc}>
            <Switch
              aria-label={text.sessionAutoRetry}
              isSelected={autoRetry}
              onChange={(on) => void setAutoRetry(on)}
              data-testid="v3-session-auto-retry"
            />
          </SettingsRow>
          <PiRetryDetailRows state={piNative} text={piText} disabled={!autoRetry} />
          <SettingsRow
            settingId="session-loop-auto-continue"
            label={text.sessionLoopAutoContinue}
            description={text.sessionLoopAutoContinueDesc}
          >
            <Switch
              aria-label={text.sessionLoopAutoContinue}
              isSelected={loopAutoContinue}
              onChange={(on) => void patchSettings({ streamLoopAutoContinue: on })}
              data-testid="v3-session-loop-auto-continue"
            />
          </SettingsRow>
        </SettingsGroup>

        <PiSessionGroups state={piNative} text={piText} />
      </SettingsAdvanced>
    </section>
  )
}
