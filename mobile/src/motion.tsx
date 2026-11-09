import { pick } from '../../src/shared/ui-lang'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { font, mono, usePalette } from './theme'

const duration = { fast: 110, base: 170, slow: 240 }
const ease = Easing.bezier(0.22, 1, 0.36, 1)

export function useReducedMotion() {
  const [reduced, setReduced] = useState<boolean | null>(null)
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => setReduced(true))
    const event = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => event.remove()
  }, [])
  return reduced
}

export function ContentEnter({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion()
  const value = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduced === null) return
    value.setValue(reduced ? 1 : 0)
    Animated.timing(value, { toValue: 1, duration: reduced ? 1 : duration.base, easing: ease, useNativeDriver: true }).start()
  }, [reduced, value])
  return <Animated.View style={{ flex: 1, minWidth: 0, opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}>{children}</Animated.View>
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function GlyphSpinner({ color }: { color?: string }) {
  const p = usePalette()
  const reduced = useReducedMotion()
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (reduced !== false) return
    const id = setInterval(() => setStep((current) => (current + 1) % BRAILLE.length), 80)
    return () => clearInterval(id)
  }, [reduced])
  return <Text accessibilityElementsHidden importantForAccessibility="no" style={[glyphStyle.glyph, { color: color ?? p.accent }]}>{reduced === false ? BRAILLE[step] : '●'}</Text>
}

const glyphStyle = StyleSheet.create({ glyph: { width: 14, textAlign: 'center', fontFamily: mono, fontSize: font.sm } })

export function RunDot({ color, label }: { color?: string; label?: string }) {
  const p = usePalette()
  return <View accessibilityLabel={label} style={{ width: 6, height: 6, backgroundColor: color ?? p.accent }} />
}

const AnimatedPath = Animated.createAnimatedComponent(Path)
const FRAME_LENGTH = 182

export function BootSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const p = usePalette()
  const reduced = useReducedMotion()
  const draw = useRef(new Animated.Value(0)).current
  const prompt = useRef(new Animated.Value(0)).current
  const cursor = useRef(new Animated.Value(0)).current
  const fade = useRef(new Animated.Value(1)).current
  const [timedOut, setTimedOut] = useState(false)
  const introDone = useRef(false)
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), 2500)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => {
    if (reduced === null) return
    if (reduced) { draw.setValue(1); prompt.setValue(1); cursor.setValue(1); return }
    const breathe = Animated.loop(Animated.sequence([
      Animated.timing(cursor, { toValue: 0.35, duration: 600, easing: Easing.bezier(0.45, 0, 0.55, 1), useNativeDriver: false }),
      Animated.timing(cursor, { toValue: 1, duration: 600, easing: Easing.bezier(0.45, 0, 0.55, 1), useNativeDriver: false })
    ]))
    const intro = Animated.parallel([
      Animated.timing(draw, { toValue: 1, duration: duration.slow * 2, easing: ease, useNativeDriver: false }),
      Animated.timing(prompt, { toValue: 1, duration: duration.base, delay: duration.slow * 1.5, easing: ease, useNativeDriver: false }),
      Animated.timing(cursor, { toValue: 1, duration: duration.base, delay: duration.slow * 2, easing: ease, useNativeDriver: false })
    ])
    intro.start(({ finished }) => { if (finished) { introDone.current = true; breathe.start() } })
    return () => { intro.stop(); breathe.stop() }
  }, [reduced, draw, prompt, cursor])
  useEffect(() => {
    if (!ready && !timedOut) return
    const wait = reduced || introDone.current || timedOut ? 0 : 500
    const id = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: reduced ? 1 : duration.base, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }).start(() => onDone()), wait)
    return () => clearTimeout(id)
  }, [ready, timedOut, reduced, fade, onDone])
  return <Animated.View accessibilityLabel={pick('砚 正在启动', 'Inkstone starting')} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 100, alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg0, opacity: fade }}>
    <Svg width={64} height={64} viewBox="0 0 100 100" fill="none">
      <AnimatedPath d="M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53" stroke={p.fg} strokeWidth={6} strokeLinejoin="round" strokeDasharray={[FRAME_LENGTH, FRAME_LENGTH]} strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [FRAME_LENGTH, 0] })} />
      <AnimatedPath d="M36 40L47 50L36 60" stroke={p.accent} strokeWidth={6} strokeLinecap="square" strokeLinejoin="miter" opacity={prompt} />
      <AnimatedPath d="M57 62H69" stroke={p.accent} strokeWidth={6} strokeLinecap="square" opacity={cursor} />
    </Svg>
  </Animated.View>
}
