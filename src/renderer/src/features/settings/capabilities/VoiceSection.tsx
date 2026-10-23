import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, Meter } from '../../../ui'
import {
  VOICE_LANGUAGES,
  type VoiceDownloadPlan,
  type VoiceInputSettings,
  type VoiceInputStatus,
  type VoiceLanguage,
  type VoiceModelTier
} from '../../../../../shared/voice-input'
import { Segmented, SettingsRow } from '../root/controls'
import { useCapsText } from './text'
import { Actions, Entry, Group, Meta, Note, Panel, Warn } from './parts'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

type VoiceSetup = ReturnType<typeof useVoiceSetup>

export function useVoiceSetup() {
  const t = useT()
  const saved = useStore((s) => s.settings?.voiceInput)
  const [status, setStatus] = useState<VoiceInputStatus | null>(null)
  const [plan, setPlan] = useState<VoiceDownloadPlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const refreshGeneration = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      refreshGeneration.current++
    }
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    try {
      const next = await window.yan.voice.status()
      if (alive.current && generation === refreshGeneration.current) {
        setStatus(next)
        setError('')
      }
    } catch (cause) {
      if (alive.current && generation === refreshGeneration.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const downloading = status?.download?.state === 'running'
  useEffect(() => {
    if (!downloading) return undefined
    const id = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(id)
  }, [downloading, refresh])

  const save = async (next: VoiceInputSettings): Promise<void> => {
    try {
      await window.yan.patchSettings({ voiceInput: next })
      const settings = await window.yan.getSettings()
      if (!alive.current) return
      useStore.setState({ settings })
      setError('')
      await refresh()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const askPlan = async (target: VoiceDownloadPlan['target']): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.voice.plan(target)
      if (!alive.current) return
      if (result.ok) setPlan(result.plan)
      else setError(result.error)
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const confirmDownload = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    try {
      const result = await window.yan.voice.download(plan.planId)
      if (result.ok && plan.target.kind === 'model') await save({ ...(saved ?? {}), model: { kind: 'catalog', id: plan.target.id } })
      if (!result.ok) setError(result.error ?? t('voice.downloadFailed'))
      setPlan(null)
      await refresh()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) {
        setBusy(false)
        setPlan(null)
      }
    }
  }

  const pick = async (kind: 'binary' | 'model'): Promise<void> => {
    try {
      const next = await window.yan.voice.pick(kind)
      if (next) {
        const settings = await window.yan.getSettings()
        if (!alive.current) return
        setStatus(next)
        useStore.setState({ settings })
      }
      if (alive.current) setError('')
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return { saved, status, plan, setPlan, error, busy, downloading, refresh, save, askPlan, confirmDownload, pick }
}

export function VoiceStatusPanel({ voice }: { voice: VoiceSetup }): ReactElement {
  const t = useT()
  const text = useCapsText()
  const { saved, status, error, refresh, save } = voice
  const download = status?.download
  return (
    <Panel label={t('voice.title')}>
      <div className="caps-stack" data-testid="settings-voice" data-setting-id="caps-tools-voice">
        <Group title={t('voice.title')} desc={t('voice.desc')}>
          <div className="caps-list">
            <Entry
              name={status?.model?.label ?? t('voice.title')}
              meta={[
                <span key="state" data-testid="voice-state">
                  {status?.ready ? t('voice.ready') : t('voice.notReady')}
                </span>,
                status?.backend && status.backend !== 'unknown' ? (status.backend === 'cuda' ? 'CUDA · GPU' : 'CPU') : null,
                status && !status.ready ? text('voiceSetupHint') : null
              ]}
            />

            {download ? (
              <Entry
                testId="voice-download"
                name={download.label}
                meta={[
                  download.state === 'running'
                    ? t('voice.progress', { got: fmtBytes(download.received), total: fmtBytes(download.total) })
                    : download.state === 'done'
                      ? t('voice.downloadDone')
                      : download.state === 'cancelled'
                        ? t('voice.downloadCancelled')
                        : t('voice.downloadFailedMsg', { msg: download.error ?? '' })
                ]}
                actions={
                  download.state === 'running' ? (
                    <Button variant="secondary" onPress={() => void window.yan.voice.cancel().then(refresh)}>
                      {t('voice.cancelDownload')}
                    </Button>
                  ) : null
                }
              >
                {download.state === 'running' ? (
                  <Meter aria-label={download.label} value={download.received} minValue={0} maxValue={download.total || 1} />
                ) : null}
              </Entry>
            ) : null}

            <div className="settings-rows">
              <SettingsRow label={t('voice.language')} description={t('voice.languageDesc')} settingId="caps-tools-voice-language">
                <Segmented<VoiceLanguage>
                  label={t('voice.language')}
                  value={status?.language ?? 'auto'}
                  options={VOICE_LANGUAGES.map((lang) => ({
                    value: lang,
                    label: t(`voice.lang.${lang}` as 'voice.lang.auto'),
                    testId: `voice-language-${lang}`
                  }))}
                  onChange={(language) => void save({ ...(saved ?? {}), language })}
                />
              </SettingsRow>
            </div>
          </div>
          {error ? <Warn>{error}</Warn> : null}
        </Group>
      </div>
    </Panel>
  )
}

export function VoiceSetupPanel({ voice }: { voice: VoiceSetup }): ReactElement {
  const t = useT()
  const text = useCapsText()
  const { saved, status, plan, setPlan, busy, downloading, save, askPlan, confirmDownload, pick } = voice
  const hw = status?.hardware
  const tierLabel = (tier: VoiceModelTier): string => t(`voice.tier.${tier}` as 'voice.tier.light')
  return (
    <Panel label={text('voiceSetupTitle')}>
      <div className="caps-stack" data-testid="settings-voice-setup">
        <Group title={t('voice.engine')} desc={t('voice.engineDesc')}>
          <Entry
            testId="voice-binary"
            name={status?.binary ? (status.binary.source === 'custom' ? t('voice.engineCustom') : t('voice.engineManaged')) : t('voice.engineMissing')}
            meta={[status?.binary?.path]}
            metaTitle={status?.binary?.path}
            actions={
              <>
                <Button variant="secondary" isDisabled={busy || downloading} onPress={() => void askPlan({ kind: 'binary' })}>
                  {status?.binary?.source === 'managed' ? t('voice.engineUpdate') : t('voice.engineDownload')}
                </Button>
                <Button variant="secondary" onPress={() => void pick('binary')}>
                  {t('voice.pickEngine')}
                </Button>
                {saved?.binaryPath ? (
                  <Button variant="secondary" onPress={() => void save({ ...saved, binaryPath: undefined })}>
                    {t('voice.clearEngine')}
                  </Button>
                ) : null}
              </>
            }
          />
        </Group>

        <div data-testid="voice-models">
          <Group title={t('voice.models')} desc={t('voice.modelsDesc')}>
            {status?.candidates.length ? (
              <div className="caps-list">
                {status.candidates.map((candidate) => {
                  const selected = status.model?.catalogId === candidate.spec.id
                  return (
                    <Entry
                      key={candidate.spec.id}
                      testId={`voice-model-${candidate.spec.id}`}
                      name={tierLabel(candidate.spec.tier)}
                      meta={[
                        selected ? t('voice.inUse') : null,
                        candidate.recommended ? t('voice.recommended') : null,
                        t('voice.modelLine', {
                          file: candidate.spec.file,
                          size: fmtBytes(candidate.spec.approxBytes),
                          mem: candidate.spec.approxMemoryMB
                        })
                      ]}
                      actions={
                        candidate.installed ? (
                          <Button
                            variant="secondary"
                            isDisabled={selected}
                            onPress={() => void save({ ...(saved ?? {}), model: { kind: 'catalog', id: candidate.spec.id } })}
                          >
                            {selected ? t('voice.inUse') : t('voice.use')}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            isDisabled={busy || downloading}
                            onPress={() => void askPlan({ kind: 'model', id: candidate.spec.id })}
                          >
                            {t('voice.download')}
                          </Button>
                        )
                      }
                    >
                      {candidate.strain ? <Warn>{candidate.strain}</Warn> : null}
                    </Entry>
                  )
                })}
              </div>
            ) : null}
            <Actions>
              <Button variant="secondary" onPress={() => void pick('model')}>
                {t('voice.pickModel')}
              </Button>
              {saved?.model?.kind === 'file' ? <Meta title={saved.model.path}>{saved.model.path}</Meta> : null}
            </Actions>
          </Group>
        </div>

        {plan ? (
          <Entry
            testId="voice-confirm"
            name={t('voice.confirmTitle')}
            meta={[
              t('voice.confirmLine', { label: plan.label, size: `${plan.sizeKnown ? '' : '≈'}${fmtBytes(plan.bytes)}` }),
              t('voice.confirmWhere', { path: plan.destination }),
              plan.url
            ]}
            metaTitle={[
              t('voice.confirmLine', { label: plan.label, size: `${plan.sizeKnown ? '' : '≈'}${fmtBytes(plan.bytes)}` }),
              t('voice.confirmWhere', { path: plan.destination }),
              plan.url
            ].join(' · ')}
            actions={
              <>
                <Button variant="secondary" onPress={() => setPlan(null)}>
                  {t('voice.confirmNo')}
                </Button>
                <Button variant="primary" onPress={() => void confirmDownload()} data-testid="voice-confirm-yes">
                  {t('voice.confirmYes')}
                </Button>
              </>
            }
          />
        ) : null}

        {hw ? (
          <Meta>
            {t('voice.hardware')}：
            {t('voice.hardwareLine', {
              cpu: hw.cpuModel || '—',
              threads: hw.threads,
              free: (hw.freeMemoryMB / 1024).toFixed(1),
              total: (hw.totalMemoryMB / 1024).toFixed(1),
              load: hw.cpuLoad === null ? '—' : `${Math.round(hw.cpuLoad * 100)}%`
            })}
            {hw.gpu ? ` ${t('voice.gpuNote', { gpu: hw.gpu })}` : ''}
          </Meta>
        ) : null}
        <Note>{t('voice.privacy', { dir: status?.storageDir ?? '' })}</Note>
      </div>
    </Panel>
  )
}
