import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, BackHandler, Easing, Keyboard, Pressable, Text, View } from 'react-native'
import { cancelSpeech, recognizeSpeech, stopSpeech, subscribeSpeech, type SpeechPhase } from '../speech'
import { font, radius, space, touch, usePalette } from '../theme'
import { IconButton } from '../ui'
import { Icon } from '../icons'
import { useReducedMotion } from '../motion'

/** A real audio level, confined to the existing composer action row. */
function VoiceWave({ level }: { level: number }) {
  const p = usePalette()
  const reduced = useReducedMotion()
  const value = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const animation = Animated.timing(value, { toValue: level, duration: reduced === false ? 110 : 0, easing: Easing.out(Easing.quad), useNativeDriver: true })
    animation.start()
    return () => animation.stop()
  }, [level, reduced, value])
  return <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 18 }}>
    {[0.45, 0.75, 1, 0.75, 0.45].map((weight, index) => <Animated.View key={index} style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: p.accent, transform: [{ scaleY: value.interpolate({ inputRange: [0, 1], outputRange: [0.17, weight] }) }] }} />)}
  </View>
}

export function SpeechInputButton({ onText, onError, onStateChange, disabled }: {
  onText: (text: string) => void
  onError?: (message: string | null) => void
  onStateChange?: (state: SpeechPhase) => void
  disabled?: boolean
}) {
  const p = usePalette()
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<SpeechPhase>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const cancelled = useRef(false)
  const mounted = useRef(true)
  const callbacks = useRef({ onText, onError, onStateChange })
  callbacks.current = { onText, onError, onStateChange }

  const cancel = () => {
    cancelled.current = true
    cancelSpeech()
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = subscribeSpeech((event) => {
      if (!active.current || event.state === 'idle') return
      setPhase(event.state)
      setLevel(event.level)
      callbacks.current.onStateChange?.(event.state)
    })
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!active.current) return false
      cancel()
      return true
    })
    return () => {
      mounted.current = false
      unsubscribe()
      back.remove()
      if (active.current) cancel()
    }
  }, [])

  const start = async () => {
    if (active.current) return
    Keyboard.dismiss()
    active.current = true
    cancelled.current = false
    setBusy(true)
    setPhase('starting')
    setLevel(0)
    setError(null)
    callbacks.current.onError?.(null)
    callbacks.current.onStateChange?.('starting')
    try {
      const text = await recognizeSpeech(() => cancelled.current || !mounted.current)
      if (text && !cancelled.current && mounted.current) callbacks.current.onText(text)
    } catch (err) {
      if (!cancelled.current && mounted.current) {
        const message = err instanceof Error ? err.message : '语音识别失败'
        setError(message)
        callbacks.current.onError?.(message)
      }
    } finally {
      active.current = false
      if (mounted.current) {
        setBusy(false)
        setPhase('idle')
        setLevel(0)
        callbacks.current.onStateChange?.('idle')
      }
    }
  }

  return <View style={{ gap: space[1] }}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {busy ? <>
        <Pressable accessibilityRole="button" accessibilityLabel={phase === 'processing' ? '正在转写语音' : '结束录音并转写'} accessibilityState={{ disabled: phase !== 'listening' }} disabled={phase !== 'listening'} onPress={stopSpeech} style={({ pressed }) => ({ minHeight: touch.min, minWidth: touch.min, paddingHorizontal: 8, borderRadius: radius.md, backgroundColor: p.accentSoft, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.65 : 1 })}>
          {phase === 'listening' ? <><VoiceWave level={level} /><Icon name="stop" size={13} color={p.accent} /></> : <ActivityIndicator size="small" color={p.accent} />}
        </Pressable>
        <IconButton name="close" label="取消语音输入" onPress={cancel} />
      </> : <IconButton name="audio" label="语音转文字，核对后发送" disabled={disabled} onPress={() => void start()} />}
    </View>
    {error && !onError ? <Text accessibilityLiveRegion="polite" style={{ color: p.err, fontSize: font.xs }}>{error}</Text> : null}
  </View>
}
