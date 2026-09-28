import { useEffect, useState } from 'react'
import { NativeEventEmitter, NativeModules } from 'react-native'

export interface FoldLayout {
  separating: boolean
  orientation?: 'horizontal' | 'vertical'
  posture?: 'flat' | 'half-open'
  left?: number; right?: number; top?: number; bottom?: number
}

export function useFoldLayout() {
  const [layout, setLayout] = useState<FoldLayout>({ separating: false })
  useEffect(() => {
    const native = NativeModules.InkstoneFoldLayout
    if (!native) return
    let subscribed = true
    let received = false
    const events = new NativeEventEmitter(native)
    const subscription = events.addListener('inkstone-fold-layout', (next: FoldLayout) => { received = true; setLayout(next) })
    void native.getCurrent().then((next: FoldLayout) => { if (subscribed && !received) setLayout(next) }).catch(() => {})
    return () => { subscribed = false; subscription.remove() }
  }, [])
  return layout
}
