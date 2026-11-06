import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export function useBottomInset(): number {
  const { bottom } = useSafeAreaInsets()
  const [keyboard, setKeyboard] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  return keyboard ? 0 : bottom
}
