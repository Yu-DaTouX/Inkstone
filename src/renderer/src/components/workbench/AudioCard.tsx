import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { audioBoundaryText, type AudioPlan } from '../../../../shared/audio'

/**
 * 语音与内容形式（实施-25 P20）。
 *
 * 这张卡**不做识别也不做朗读**：它只说清「该走哪条路」、并把外部工具转好的文本
 * 登记成**同一门课**的新来源。所以界面上最显眼的两句是：
 *   · 砚不自带语音识别与朗读（要走外部能力）；
 *   · 音频与转写属于同一门课（不新建课程、不多一份学习记录）。
 */
export function AudioCard({ courseId, sourceId, version }: { courseId?: string; sourceId?: string; version?: number }): React.JSX.Element | null {
  const t = useT()
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  const [plan, setPlan] = useState<AudioPlan | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  if (!courseId) return null

  const loadPlan = async (task: 'transcribe' | 'read-aloud'): Promise<void> => {
    setError('')
    setNote('')
    try {
      const res = await window.yan.audio.plan({
        task,
        courseId,
        ...(sourceId ? { sourceId } : {}),
        ...(version ? { version } : {})
      })
      if (!res.ok || !res.plan) {
        setError(res.error ?? t('space.audio.planFailed'))
        return
      }
      setPlan(res.plan)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('space.audio.planFailed'))
    }
  }

  const register = async (): Promise<void> => {
    setError('')
    setNote('')
    if (!sourceId) {
      setError(t('space.audio.needSource'))
      return
    }
    try {
      const res = await window.yan.audio.transcript({
        courseId,
        sourceId,
        ...(version ? { version } : {}),
        text
      })
      if (!res.ok) {
        setError(res.error ?? t('space.audio.registerFailed'))
        return
      }
      setNote(res.note ?? '')
      setText('')
      await refreshLibrary()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('space.audio.registerFailed'))
    }
  }

  return (
    <div className="wb-memory-panel wb-audio" data-testid="space-learn-audio">
      <div className="wb-learn-ws-answer-head">
        <Icon name="audio" size={12} />
        <span>{t('space.audio.head')}</span>
      </div>
      <p className="wb-card-meta" data-testid="space-audio-boundary">
        {audioBoundaryText()}
      </p>
      <div className="wb-audio-actions">
        <button className="wb-btn" data-testid="space-audio-plan-transcribe" onClick={() => void loadPlan('transcribe')}>
          {t('space.audio.howTranscribe')}
        </button>
        <button className="wb-btn" data-testid="space-audio-plan-read" onClick={() => void loadPlan('read-aloud')}>
          {t('space.audio.howRead')}
        </button>
      </div>
      {plan ? (
        <div className="wb-audio-plan" data-testid="space-audio-plan">
          <pre className="wb-audio-text" data-testid="space-audio-plan-text">
            {plan.text}
          </pre>
          <button
            className="wb-btn"
            data-testid="space-audio-send"
            onClick={() => {
              insertIntoComposer(plan.text)
              setNote(t('space.audio.sent'))
            }}
          >
            <Icon name="send" size={12} />
            {t('space.audio.send')}
          </button>
        </div>
      ) : null}

      {/* 外部工具转好之后：粘进来、归到同一门课 */}
      <textarea
        className="wb-ex-input wb-audio-transcript"
        data-testid="space-audio-transcript"
        rows={3}
        value={text}
        placeholder={t('space.audio.transcriptPlaceholder')}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="wb-audio-actions">
        <button className="wb-btn" data-testid="space-audio-register" onClick={() => void register()}>
          {t('space.audio.register')}
        </button>
        {sourceId ? (
          <span className="wb-card-meta" data-testid="space-audio-source">
            {t('space.audio.sourceLabel', { source: sourceId })}
          </span>
        ) : (
          <span className="wb-card-meta" data-testid="space-audio-no-source">
            {t('space.audio.needSource')}
          </span>
        )}
      </div>
      {error ? (
        <p className="wb-card-meta wb-audio-error" data-testid="space-audio-error">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="wb-card-meta wb-audio-note" data-testid="space-audio-note">
          {note}
        </p>
      ) : null}
    </div>
  )
}
