import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Animated, Easing, View } from 'react-native'
import { usePalette } from './theme'

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
