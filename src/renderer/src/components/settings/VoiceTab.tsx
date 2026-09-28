import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { Badge, Button, Segmented } from '../ui'
import { useStore } from '../../state/store'
import {
  VOICE_LANGUAGES,
  type VoiceDownloadPlan,
  type VoiceInputSettings,
  type VoiceInputStatus,
  type VoiceLanguage,
  type VoiceModelTier
} from '../../../../shared/voice-input'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

/**
 * 设置 · 语音输入（需求稿 3.5）。
 *
 * 转写全部在这台电脑上完成（whisper.cpp）。这一页负责：按配置推荐模型、
 * 下载前先给出核实过的大小与保存位置并等用户确认、或指定已有的程序与模型文件、选择识别语言。
 */
export function VoiceTab() {
  const t = useT()
  const saved = useStore((s) => s.settings?.voiceInput)
  const [status, setStatus] = useState<VoiceInputStatus | null>(null)
  const [plan, setPlan] = useState<VoiceDownloadPlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.yan.voice.status())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* 下载进行中每秒刷新一次进度 */
  const downloading = status?.download?.state === 'running'
  useEffect(() => {
    if (!downloading) return undefined
    const id = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(id)
  }, [downloading, refresh])

  const save = async (next: VoiceInputSettings): Promise<void> => {
    await window.yan.patchSettings({ voiceInput: next })
    useStore.setState({ settings: await window.yan.getSettings() })
    await refresh()
  }

  const askPlan = async (target: VoiceDownloadPlan['target']): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.voice.plan(target)
      if (result.ok) setPlan(result.plan)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  const confirmDownload = async (): Promise<void> => {
    if (!plan) return
    const result = await window.yan.voice.download(plan.planId)
    /* 下载的是模型时，顺手把它设为选用的模型（下完才会真正生效） */
    if (result.ok && plan.target.kind === 'model') await save({ ...(saved ?? {}), model: { kind: 'catalog', id: plan.target.id } })
    if (!result.ok) setError(result.error ?? t('voice.downloadFailed'))
    setPlan(null)
    await refresh()
  }

  const pick = async (kind: 'binary' | 'model'): Promise<void> => {
    const next = await window.yan.voice.pick(kind)
    if (next) {
      setStatus(next)
      useStore.setState({ settings: await window.yan.getSettings() })
    }
  }

  const hw = status?.hardware
  const download = status?.download
  const tierLabel = (tier: VoiceModelTier): string => t(`voice.tier.${tier}` as 'voice.tier.light')

  return (
    <div className="set-group" data-testid="settings-voice">
      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('voice.title')}</div>
          <div className="set-desc">{t('voice.desc')}</div>
        </div>
        <div className="set-desc" data-testid="voice-state">
          {status?.ready ? <Badge tone="ok">{t('voice.ready')}</Badge> : <Badge>{t('voice.notReady')}</Badge>}
          {status?.model ? <span className="set-path"> {status.model.label}</span> : null}
        </div>
      </div>

      {hw ? (
        <div className="set-row col">
          <div className="set-label">
            <div className="set-name">{t('voice.hardware')}</div>
            <div className="set-desc">
              {t('voice.hardwareLine', {
                cpu: hw.cpuModel || '—',
                threads: hw.threads,
                free: (hw.freeMemoryMB / 1024).toFixed(1),
                total: (hw.totalMemoryMB / 1024).toFixed(1),
                load: hw.cpuLoad === null ? '—' : `${Math.round(hw.cpuLoad * 100)}%`
              })}
              {hw.gpu ? <div>{t('voice.gpuNote', { gpu: hw.gpu })}</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="set-row col" data-testid="voice-models">
        <div className="set-label">
          <div className="set-name">{t('voice.models')}</div>
          <div className="set-desc">{t('voice.modelsDesc')}</div>
        </div>
        <div className="voice-models">
          {status?.candidates.map((c) => {
            const selected = status.model?.catalogId === c.spec.id
            return (
              <div className={`voice-model ${selected ? 'on' : ''}`} key={c.spec.id} data-testid={`voice-model-${c.spec.id}`}>
                <div className="voice-model-head">
                  <span className="set-name">{tierLabel(c.spec.tier)}</span>
                  {c.recommended ? <Badge tone="accent">{t('voice.recommended')}</Badge> : null}
                  {selected ? <Badge tone="ok">{t('voice.inUse')}</Badge> : null}
                </div>
                <div className="set-desc">
                  {t('voice.modelLine', { file: c.spec.file, size: fmtBytes(c.spec.approxBytes), mem: c.spec.approxMemoryMB })}
                </div>
                {c.strain ? <div className="set-warn">{c.strain}</div> : null}
                <div className="btn-row">
                  {c.installed ? (
                    <Button size="sm" disabled={selected} onClick={() => void save({ ...(saved ?? {}), model: { kind: 'catalog', id: c.spec.id } })}>
                      {selected ? t('voice.inUse') : t('voice.use')}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={busy || downloading} onClick={() => void askPlan({ kind: 'model', id: c.spec.id })}>
                      {t('voice.download')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="btn-row">
          <Button size="sm" onClick={() => void pick('model')}>{t('voice.pickModel')}</Button>
          {saved?.model?.kind === 'file' ? <span className="set-path">{saved.model.path}</span> : null}
        </div>
      </div>

      <div className="set-row col" data-testid="voice-binary">
        <div className="set-label">
          <div className="set-name">{t('voice.engine')}</div>
          <div className="set-desc">{t('voice.engineDesc')}</div>
        </div>
        <div className="set-desc">
          {status?.binary ? (
            <>
              <Badge tone="ok">{status.binary.source === 'custom' ? t('voice.engineCustom') : t('voice.engineManaged')}</Badge>{' '}
              <span className="set-path">{status.binary.path}</span>
            </>
          ) : (
            <Badge>{t('voice.engineMissing')}</Badge>
          )}
        </div>
        <div className="btn-row">
          <Button size="sm" disabled={busy || downloading} onClick={() => void askPlan({ kind: 'binary' })}>
            {status?.binary?.source === 'managed' ? t('voice.engineUpdate') : t('voice.engineDownload')}
          </Button>
          <Button size="sm" onClick={() => void pick('binary')}>{t('voice.pickEngine')}</Button>
          {saved?.binaryPath ? (
            <Button size="sm" variant="ghost" onClick={() => void save({ ...saved, binaryPath: undefined })}>
              {t('voice.clearEngine')}
            </Button>
          ) : null}
        </div>
      </div>

      {plan ? (
        <div className="set-row col voice-confirm" role="dialog" aria-label={t('voice.confirmTitle')} data-testid="voice-confirm">
          <div className="set-label">
            <div className="set-name">{t('voice.confirmTitle')}</div>
            <div className="set-desc">
              {t('voice.confirmLine', { label: plan.label, size: `${plan.sizeKnown ? '' : '≈'}${fmtBytes(plan.bytes)}` })}
              <br />
              {t('voice.confirmWhere', { path: plan.destination })}
              <br />
              <span className="set-path">{plan.url}</span>
            </div>
          </div>
          <div className="btn-row">
            <Button variant="primary" size="sm" onClick={() => void confirmDownload()} data-testid="voice-confirm-yes">
              {t('voice.confirmYes')}
            </Button>
            <Button size="sm" onClick={() => setPlan(null)}>{t('voice.confirmNo')}</Button>
          </div>
        </div>
      ) : null}

      {download ? (
        <div className="set-row col" data-testid="voice-download">
          <div className="set-label">
            <div className="set-name">{download.label}</div>
            <div className="set-desc">
              {download.state === 'running'
                ? t('voice.progress', { got: fmtBytes(download.received), total: fmtBytes(download.total) })
                : download.state === 'done'
                  ? t('voice.downloadDone')
                  : download.state === 'cancelled'
                    ? t('voice.downloadCancelled')
                    : t('voice.downloadFailedMsg', { msg: download.error ?? '' })}
            </div>
          </div>
          {download.state === 'running' ? (
            <>
              <progress className="voice-progress" max={download.total || 1} value={download.received} />
              <div className="btn-row">
                <Button size="sm" onClick={() => void window.yan.voice.cancel().then(refresh)}>{t('voice.cancelDownload')}</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('voice.language')}</div>
          <div className="set-desc">{t('voice.languageDesc')}</div>
        </div>
        <div className="set-ctl">
          <Segmented<VoiceLanguage>
            value={status?.language ?? 'auto'}
            label={t('voice.language')}
            testId="voice-language"
            options={VOICE_LANGUAGES.map((lang) => ({ value: lang, label: t(`voice.lang.${lang}` as 'voice.lang.auto') }))}
            onChange={(language) => void save({ ...(saved ?? {}), language })}
          />
        </div>
      </div>

      <div className="set-row col">
        <div className="set-desc">{t('voice.privacy', { dir: status?.storageDir ?? '' })}</div>
        {error ? <div className="set-warn" role="alert">{error}</div> : null}
      </div>
    </div>
  )
}
