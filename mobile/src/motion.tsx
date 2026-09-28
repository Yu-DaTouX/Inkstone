import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, Easing, View } from 'react-native'
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

/** An indeterminate loading bar. Never presents a fabricated percentage. */
export function LoadingBar({ active }: { active: boolean }) {
  const p = usePalette()
  const reduced = useReducedMotion()
  const [width, setWidth] = useState(0)
  const progress = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!active || reduced !== false) return
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => { loop.stop(); progress.setValue(0) }
  }, [active, reduced, progress])
  return <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height: 2, overflow: 'hidden', backgroundColor: active ? p.borderSoft : 'transparent' }}>
    {active ? <Animated.View style={{ position: 'absolute', height: 2, backgroundColor: p.accent, width: reduced ? '100%' : width * 0.3, transform: reduced ? [] : [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.3, width] }) }] }} /> : null}
  </View>
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
