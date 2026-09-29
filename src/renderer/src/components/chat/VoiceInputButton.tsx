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

type Phase = { kind: 'idle' } | { kind: 'recording'; startedAt: number } | { kind: 'preparing' } | { kind: 'transcribing' } | { kind: 'error'; message: string }

export function VoiceInputButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const t = useT()
  const openSettings = useStore((s) => s.openSettings)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [now, setNow] = useState(Date.now())
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
    if (!prepared.ok) { setPhase({ kind: 'error', message: prepared.error ?? t('voice.notReady') }); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      if (generation.current !== token || cancelled.current) return
      setPhase({ kind: 'error', message: t('voice.micDenied') })
      return
    }
    if (generation.current !== token || cancelled.current) { stream.getTracks().forEach((track) => track.stop()); return }
    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const muted = context.createGain(); muted.gain.value = 0
    source.connect(processor); processor.connect(muted); muted.connect(context.destination)
    let samples: number[] = [], stopped = false, failed = false
    let pending = Promise.resolve()
    const flush = (): void => {
      if (!samples.length) return
      const original = Float32Array.from(samples); samples = []
      const ratio = context.sampleRate / 16000
      const pcm = new Float32Array(Math.floor(original.length / ratio))
      for (let i = 0; i < pcm.length; i++) pcm[i] = original[Math.min(original.length - 1, Math.floor(i * ratio))]
      const wav = encodeWav16k(pcm)
      pending = pending.then(async () => {
        if (cancelled.current || generation.current !== token || failed) return
        const result = await window.yan.voice.transcribe(wav, status.language)
        if (cancelled.current || generation.current !== token) return
        if (!result.ok) { failed = true; recorder.current?.stop(); setPhase({ kind: 'error', message: result.error }); return }
        onTextRef.current(result.text)
      }).catch((error) => { if (generation.current === token && !cancelled.current) { failed = true; recorder.current?.stop(); setPhase({ kind: 'error', message: String(error) }) } })
    }
    processor.onaudioprocess = (event) => {
      if (stopped) return
      samples.push(...event.inputBuffer.getChannelData(0))
      if (samples.length >= context.sampleRate * 5) flush()
    }
    recorder.current = { stop: () => {
      if (stopped) return
      stopped = true; processor.disconnect(); source.disconnect(); muted.disconnect()
      stream.getTracks().forEach((track) => track.stop()); void context.close(); recorder.current = null
      if (cancelled.current) { samples = []; if (generation.current === token) setPhase({ kind: 'idle' }); return }
      flush()
      if (!failed) setPhase({ kind: 'transcribing' })
      void pending.then(() => { if (generation.current === token && !failed && !cancelled.current) setPhase({ kind: 'idle' }) })
    } }
    const at = Date.now(); setNow(at); setPhase({ kind: 'recording', startedAt: at })
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
        disabled={disabled || phase.kind === 'preparing' || phase.kind === 'transcribing'}
        onClick={() => void start()}
        title={t('voice.start')}
        aria-label={t('voice.start')}
        data-testid="voice-start"
      >
        <Icon name="mic" size={12} />
        {phase.kind === 'preparing' ? <span>{t('voice.preparing')}</span> : null}
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
