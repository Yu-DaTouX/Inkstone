import { pick } from '../../../src/shared/ui-lang'
import { StyleSheet, Text, View } from 'react-native'
import { font, radius, space, usePalette, weight } from '../theme'

const SHOWN = 3

export function queuedRows(queue: { steering: string[]; followUp: string[] } | undefined): { kind: 'steer' | 'queue'; text: string }[] {
  if (!queue) return []
  return [
    ...queue.steering.map((text) => ({ kind: 'steer' as const, text })),
    ...queue.followUp.map((text) => ({ kind: 'queue' as const, text }))
  ]
}

export function QueuedMessages({ queue }: { queue: { steering: string[]; followUp: string[] } | undefined }) {
  const p = usePalette()
  const rows = queuedRows(queue)
  if (!rows.length) return null
  const more = rows.length - SHOWN
  return (
    <View accessibilityLabel={pick(`${rows.length} 条消息等待发送`, `${rows.length} messages waiting to send`)} style={[styles.box, { backgroundColor: p.bg3 }]}>
      {rows.slice(0, SHOWN).map((row, index) => (
        <View key={index} style={styles.row}>
          <Text style={[styles.tag, { color: row.kind === 'steer' ? p.accent : p.fgMute }]}>
            {row.kind === 'steer' ? pick('插话', 'Steer') : pick('排队', 'Queued')}
          </Text>
          <Text numberOfLines={2} style={[styles.text, { color: p.fgDim }]}>{row.text.replace(/\s+/g, ' ').trim()}</Text>
        </View>
      ))}
      {more > 0 ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>{pick(`还有 ${more} 条`, `${more} more`)}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], gap: space[1] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  tag: { fontSize: font.xs, fontWeight: weight.strong, lineHeight: 20 },
  text: { flex: 1, fontSize: font.sm, lineHeight: 20 }
})
