import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { encodeWav16k, VOICE_MAX_SECONDS } from '../../../../shared/voice-input'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton } from '../../ui'
import { IconTip } from '../../app/IconTip'

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'preparing' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string }

/**
 * 输入框底栏的语音输入：录音 → 本地转写 → 插入光标处，由用户编辑后再发送。
 *
 * 只做转文字，不自动发送。转写走与 v2 同一个 `window.yan.voice` 接口
 * （`status` / `prepare` / `transcribe`），这里不导出第二套语音服务；外观
 * 用 v3 `ui/IconButton` 与 `app/IconTip`，不 import 任何 v2 样式。
 * 程序或模型没准备好时，点按钮直接去「设置 → 语音输入」，不在输入区里弹下载。
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const t = useT()
  const openSettings = useStore((s) => s.openSettings)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const recorder = useRef<{ stop: () => void } | null>(null)
  const generation = useRef(0)
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
      generation.current++
      recorder.current?.stop()
    },
    []
  )

  const start = async (): Promise<void> => {
    const token = ++generation.current
    cancelled.current = false
    const status = await window.yan.voice.status().catch(() => null)
    if (generation.current !== token || cancelled.current) return
    if (!status?.ready) {
      openSettings('voice')
      return
    }
    setPhase({ kind: 'preparing' })
    const prepared = await window.yan.voice.prepare().catch((error) => ({ ok: false, error: String(error) }))
    if (generation.current !== token || cancelled.current) return
    if (!prepared.ok) {
      setPhase({ kind: 'error', message: prepared.error ?? t('voice.notReady') })
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
    } catch {
      if (generation.current !== token || cancelled.current) return
      setPhase({ kind: 'error', message: t('voice.micDenied') })
      return
    }
    if (generation.current !== token || cancelled.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const muted = context.createGain()
    muted.gain.value = 0
    source.connect(processor)
    processor.connect(muted)
    muted.connect(context.destination)
    let samples: number[] = []
    let stopped = false
    let failed = false
    let pending = Promise.resolve()
    const flush = (): void => {
      if (!samples.length) return
      const original = Float32Array.from(samples)
      samples = []
      const ratio = context.sampleRate / 16000
      const pcm = new Float32Array(Math.floor(original.length / ratio))
      for (let i = 0; i < pcm.length; i++) pcm[i] = original[Math.min(original.length - 1, Math.floor(i * ratio))]
      const wav = encodeWav16k(pcm)
      pending = pending
        .then(async () => {
          if (cancelled.current || generation.current !== token || failed) return
          const result = await window.yan.voice.transcribe(wav, status.language)
          if (cancelled.current || generation.current !== token) return
          if (!result.ok) {
            failed = true
            recorder.current?.stop()
            setPhase({ kind: 'error', message: result.error })
            return
          }
          onTextRef.current(result.text)
        })
        .catch((error) => {
          if (generation.current === token && !cancelled.current) {
            failed = true
            recorder.current?.stop()
            setPhase({ kind: 'error', message: String(error) })
          }
        })
    }
    processor.onaudioprocess = (event) => {
      if (stopped) return
      samples.push(...event.inputBuffer.getChannelData(0))
      if (samples.length >= context.sampleRate * 5) flush()
    }
    recorder.current = {
      stop: () => {
        if (stopped) return
        stopped = true
        processor.disconnect()
        source.disconnect()
        muted.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void context.close()
        recorder.current = null
        if (cancelled.current) {
          samples = []
          if (generation.current === token) setPhase({ kind: 'idle' })
          return
        }
        flush()
        if (!failed) setPhase({ kind: 'transcribing' })
        void pending.then(() => {
          if (generation.current === token && !failed && !cancelled.current) setPhase({ kind: 'idle' })
        })
      }
    }
    const at = Date.now()
    setNow(at)
    setPhase({ kind: 'recording', startedAt: at })
    await context.resume()
  }

  const stop = (): void => recorder.current?.stop()
  const cancel = (): void => {
    cancelled.current = true
    recorder.current?.stop()
    generation.current++
    setPhase({ kind: 'idle' })
  }

  if (phase.kind === 'recording') {
    const seconds = Math.floor((now - phase.startedAt) / 1000)
    return (
      <span className="composer-voice" data-state="recording" data-testid="voice-recording">
        <span className="v3-visually-hidden" role="status">
          {t('voice.recordingAnnouncement')}
        </span>
        <span className="composer-voice-dot" aria-hidden />
        <span className="composer-voice-time">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>
        <IconButton
          size="sm"
          className="composer-voice-action"
          aria-label={t('voice.stop')}
          title={t('voice.stop')}
          data-testid="voice-stop"
          onPress={stop}
        >
          <Square size={12} aria-hidden />
        </IconButton>
        <IconTip label={t('voice.cancel')}>
          <IconButton
            size="sm"
            className="composer-voice-action"
            aria-label={t('voice.cancel')}
            title={t('voice.cancel')}
            data-testid="voice-cancel"
            onPress={cancel}
          >
            <X size={12} aria-hidden />
          </IconButton>
        </IconTip>
      </span>
    )
  }

  const busy = disabled || phase.kind === 'preparing' || phase.kind === 'transcribing'
  return (
    <span className="composer-voice" data-state={phase.kind}>
      <IconTip label={t('voice.start')}>
        <IconButton
          size="sm"
          className="composer-voice-action"
          aria-label={t('voice.start')}
          title={t('voice.start')}
          isDisabled={busy}
          data-testid="voice-start"
          onPress={() => void start()}
        >
          <Mic size={13} aria-hidden />
        </IconButton>
      </IconTip>
      {phase.kind === 'preparing' ? <span className="composer-voice-state">{t('voice.preparing')}</span> : null}
      {phase.kind === 'transcribing' ? <span className="composer-voice-state">{t('voice.transcribing')}</span> : null}
      {phase.kind === 'error' ? (
        <span className="composer-voice-error" role="alert" data-testid="voice-error">
          {phase.message}
        </span>
      ) : null}
    </span>
  )
}
