import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from '../icons'
import { font, mono, space, usePalette, weight } from '../theme'

export function Section({ title, value, children, initiallyOpen = true }: { title: string; value?: ReactNode; children: ReactNode; initiallyOpen?: boolean }) {
  const p = usePalette()
  const [open, setOpen] = useState(initiallyOpen)
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen(!open)} style={styles.head}>
      <Text style={[styles.title, { color: p.fgDim }]}>{title}</Text>
      <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevron-right" size={12} color={p.fgMute} /></View>
      <Text numberOfLines={1} ellipsizeMode="clip" style={[styles.leader, { color: p.borderStr }]}>{'· '.repeat(60)}</Text>
      {typeof value === 'string' ? <Text style={[styles.value, { color: p.fgDim }]}>{value}</Text> : value}
    </Pressable>
    {open ? <View style={styles.body}>{children}</View> : null}
  </View>
}

const styles = StyleSheet.create({
  head: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: space[1], marginTop: space[2] },
  title: { fontSize: font.sm, fontWeight: weight.medium },
  leader: { flex: 1, minWidth: 0, fontSize: font.xs, marginHorizontal: space[2], overflow: 'hidden' },
  value: { fontSize: font.xs, fontFamily: mono, fontVariant: ['tabular-nums'] },
  body: { gap: 2 }
})
