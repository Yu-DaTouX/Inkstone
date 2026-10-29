import { useEffect, useState } from 'react'
import { Image, View, useColorScheme } from 'react-native'
import { modelBrand } from '../../../src/shared/model-brand'
import { BOT_COLUMNS, BOT_ROW_COUNT, BOT_ROWS, BOT_SHEETS, type BotSpriteMood } from '../botSprites.generated'
import { useReducedMotion } from '../motion'

export type { BotSpriteMood }

export function ModelBot({ model, mood, size = 28 }: { model?: string; mood: BotSpriteMood; size?: number }) {
  const theme = useColorScheme() === 'light' ? 'light' : 'dark'
  const reduced = useReducedMotion()
  const row = BOT_ROWS[mood]
  const animate = reduced === false && row.frames > 1
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setFrame(0)
    if (!animate) return
    const id = setInterval(() => setFrame((current) => (current + 1) % row.frames), 1000 / row.fps)
    return () => clearInterval(id)
  }, [animate, row.frames, row.fps])
  const sheet = BOT_SHEETS[`${modelBrand(model)}-${theme}`] ?? BOT_SHEETS[`pi-${theme}`]
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, overflow: 'hidden' }}>
    <Image source={sheet} fadeDuration={0} style={{ position: 'absolute', width: BOT_COLUMNS * size, height: BOT_ROW_COUNT * size, left: -frame * size, top: -row.row * size }} />
  </View>
}
