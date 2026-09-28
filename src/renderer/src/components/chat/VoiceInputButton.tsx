/**
 * 输入框的语音输入（需求稿 3.5）：录音 → 本地转写 → 插入输入框，由用户编辑后再发送。
 *
 * 只做转文字，不自动发送。状态如实对应：录音中（显示时长、可停止或取消）→ 转写中 → 完成或失败提示。
 * 程序或模型没准备好时，点按钮直接去「设置 → 语音输入」，不在输入区里弹下载。
 */
import { useEffect, useRef, useState } from 'react'
import { encodeWav16k, VOICE_MAX_SECONDS } from '../../../../shared/voice-input'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

type Phase = { kind: 'idle' } | { kind: 'recording'; startedAt: number } | { kind: 'transcribing' } | { kind: 'error'; message: string }

export function VoiceInputButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const t = useT()
  const openSettings = useStore((s) => s.openSettings)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [now, setNow] = useState(Date.now())
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cancelled = useRef(false)
  /* 转写结束时用最新的插入函数：录音期间用户可能还在打字 */
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  /* 录音计时；到上限自动停止并转写 */
  useEffect(() => {
    if (phase.kind !== 'recording') return undefined
    const id = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current - phase.startedAt >= VOICE_MAX_SECONDS * 1000) recorder.current?.stop()
    }, 250)
    return () => window.clearInterval(id)
  }, [phase])

  /* 失败提示停留几秒后收起 */
  useEffect(() => {
    if (phase.kind !== 'error') return undefined
    const id = window.setTimeout(() => setPhase({ kind: 'idle' }), 6000)
    return () => window.clearTimeout(id)
  }, [phase])

  /* 组件卸载（切会话等）时释放麦克风，不留后台录音 */
  useEffect(
    () => () => {
      cancelled.current = true
      recorder.current?.stop()
    },
    []
  )

  const start = async (): Promise<void> => {
    const status = await window.yan.voice.status().catch(() => null)
    if (!status?.ready) {
      openSettings('voice')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      setPhase({ kind: 'error', message: t('voice.micDenied') })
      return
    }
    chunks.current = []
    cancelled.current = false
    const rec = new MediaRecorder(stream)
    recorder.current = rec
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data)
    }
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      recorder.current = null
      if (cancelled.current) {
        setPhase({ kind: 'idle' })
        return
      }
      void finish(new Blob(chunks.current, { type: rec.mimeType }), status.language)
    }
    rec.start()
    const at = Date.now()
    setNow(at)
    setPhase({ kind: 'recording', startedAt: at })
  }

  const finish = async (blob: Blob, language: 'auto' | 'zh' | 'en'): Promise<void> => {
    setPhase({ kind: 'transcribing' })
    try {
      const wav = await toWav16k(blob)
      const result = await window.yan.voice.transcribe(wav, language)
      if (!result.ok) {
        setPhase({ kind: 'error', message: result.error })
        return
      }
      onTextRef.current(result.text)
      setPhase({ kind: 'idle' })
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const stop = (): void => recorder.current?.stop()
  const cancel = (): void => {
    cancelled.current = true
    recorder.current?.stop()
  }

  if (phase.kind === 'recording') {
    const seconds = Math.floor((now - phase.startedAt) / 1000)
    return (
      <span className="voice-input recording" role="status" data-testid="voice-recording">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-time">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>
        <button type="button" className="ctool" onClick={stop} title={t('voice.stop')} data-testid="voice-stop">
          <Icon name="stop" size={12} />
          <span>{t('voice.stop')}</span>
        </button>
        <button type="button" className="ctool" onClick={cancel} title={t('voice.cancel')} aria-label={t('voice.cancel')} data-testid="voice-cancel">
          <Icon name="close" size={12} />
        </button>
      </span>
    )
  }

  return (
    <span className="voice-input">
      <button
        type="button"
        className="ctool"
        disabled={disabled || phase.kind === 'transcribing'}
        onClick={() => void start()}
        title={t('voice.start')}
        aria-label={t('voice.start')}
        data-testid="voice-start"
      >
        <Icon name="mic" size={12} />
        {phase.kind === 'transcribing' ? <span>{t('voice.transcribing')}</span> : null}
      </button>
      {phase.kind === 'error' ? (
        <span className="voice-error" role="alert" data-testid="voice-error">
          {phase.message}
        </span>
      ) : null}
    </span>
  )
}

/** 浏览器录下的压缩音频 → 16kHz 单声道 WAV（whisper.cpp 的输入格式） */
async function toWav16k(blob: Blob): Promise<Uint8Array> {
  const bytes = await blob.arrayBuffer()
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(bytes)
    const length = Math.max(1, Math.ceil(decoded.duration * 16_000))
    const offline = new OfflineAudioContext(1, length, 16_000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWav16k(rendered.getChannelData(0))
  } finally {
    void ctx.close()
  }
}
