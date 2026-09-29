import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, Easing, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { usePalette } from './theme'

/** 与桌面 --mo-fast / --mo-base / --mo-slow、--mo-ease 同值（设计规范 §6） */
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
  return <Animated.View style={{ flex: 1, opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}>{children}</Animated.View>
}

/*
 * 方点阵：3×3 方点，亮点沿外圈走一格一步、带一格尾迹，0.8s 一圈（桌面 `.ui-spin` 的同一个节拍）。
 * 取代系统转圈，运行、读取、按钮忙碌都用它。减少动画时停在第一帧，仍然可见。
 */
const RING = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]] as const

export function Spinner({ size = 12, mute = false, color, label }: { size?: number; mute?: boolean; color?: string; label?: string }) {
  const p = usePalette()
  const reduced = useReducedMotion()
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (reduced !== false) return
    const id = setInterval(() => setStep((current) => (current + 1) % RING.length), 100)
    return () => clearInterval(id)
  }, [reduced])
  const head = color ?? (mute ? p.fgDim : p.accent)
  const tail = mute ? p.fgMute : color ? head : p.accentLine
  const dot = Math.max(2, Math.round(size / 4))
  const gap = (size - dot * 3) / 2
  const cells = []
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const at = RING.findIndex(([rx, ry]) => rx === x && ry === y)
      const fill = at === step ? head : at === (step + RING.length - 1) % RING.length ? tail : p.borderStr
      cells.push(<View key={`${x}${y}`} style={{ position: 'absolute', left: x * (dot + gap), top: y * (dot + gap), width: dot, height: dot, backgroundColor: fill, opacity: at === (step + RING.length - 1) % RING.length && color ? 0.52 : 1 }} />)
    }
  }
  return <View accessibilityRole={label ? 'progressbar' : undefined} accessibilityLabel={label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'} style={{ width: size, height: size }}>{cells}</View>
}

/** Static marker for secondary running items; the active screen owns the only Spinner. */
export function RunDot({ color, label }: { color?: string; label?: string }) {
  const p = usePalette()
  return <View accessibilityLabel={label} style={{ width: 6, height: 6, backgroundColor: color ?? p.accent }} />
}

/*
 * 启动画面（设计规范 §3.4.1，与桌面同一画面）：石框从右上开口起笔描出，`>` 淡入，
 * 光标 `_` 呼吸直到 `ready`；就绪时若还没描完，等描完（至多半秒）再淡出再卸载。最长 8 秒无条件淡出。
 * 系统启动画面（Android 12+）用同一底色，交接处不闪。减少动画时直接显示静态标志。
 */
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
    const id = setTimeout(() => setTimedOut(true), 8000)
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
    /* 就绪比描画早时，最多再等半秒让标志描完再淡出，不切掉半截 */
    const wait = reduced || introDone.current || timedOut ? 0 : 500
    const id = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: reduced ? 1 : duration.base, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }).start(() => onDone()), wait)
    return () => clearTimeout(id)
  }, [ready, timedOut, reduced, fade, onDone])
  return <Animated.View accessibilityLabel="砚 正在启动" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 100, alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg0, opacity: fade }}>
    <Svg width={64} height={64} viewBox="0 0 100 100" fill="none">
      <AnimatedPath d="M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53" stroke={p.fg} strokeWidth={6} strokeLinejoin="round" strokeDasharray={[FRAME_LENGTH, FRAME_LENGTH]} strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [FRAME_LENGTH, 0] })} />
      <AnimatedPath d="M36 40L47 50L36 60" stroke={p.accent} strokeWidth={6} strokeLinecap="square" strokeLinejoin="miter" opacity={prompt} />
      <AnimatedPath d="M57 62H69" stroke={p.accent} strokeWidth={6} strokeLinecap="square" opacity={cursor} />
    </Svg>
  </Animated.View>
}
