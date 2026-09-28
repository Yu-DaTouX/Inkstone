import { memo, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { font, radius, space, touch, usePalette } from '../theme'

function Inline({ value }: { value: string }) {
  const p = usePalette()
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g)
  return <Text>{parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>
    if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={{ fontFamily: 'monospace', color: p.accent }}>{part.slice(1, -1)}</Text>
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part)
    if (link) return <Text key={index} style={{ color: p.accent, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(link[2])}>{link[1]}</Text>
    return <Text key={index}>{part}</Text>
  })}</Text>
}

/** Small, readable projection for the markdown returned by desktop history. */
export const MessageBody = memo(function MessageBody({ text, mine = false }: { text: string; mine?: boolean }) {
  const p = usePalette()
  const [expanded, setExpanded] = useState(false)
  const folded = !expanded && text.length > 8000
  const lines = (folded ? `${text.slice(0, 8000)}\n…` : text).replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<{ kind: 'text' | 'code' | 'heading' | 'list'; value: string }> = []
  let code: string[] | null = null
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push({ kind: 'code', value: code.join('\n') }); code = null }
      else code = []
      continue
    }
    if (code) { code.push(line); continue }
    if (!line.trim()) { if (blocks.at(-1)?.kind !== 'text' || blocks.at(-1)?.value !== '') blocks.push({ kind: 'text', value: '' }); continue }
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line)
    blocks.push({ kind: heading ? 'heading' : list ? 'list' : 'text', value: heading?.[1] ?? list?.[1] ?? line })
  }
  if (code) blocks.push({ kind: 'code', value: code.join('\n') })
  return <View style={[styles.body, mine && { backgroundColor: p.accentSoft, borderColor: p.accentSoft, borderWidth: 1, borderRadius: radius.lg, padding: space[3] }]}>
    {blocks.map((block, index) => block.kind === 'code' ? (
      <Pressable key={index} style={[styles.code, { backgroundColor: p.bg2, borderColor: p.borderSoft }]}><Text selectable style={{ color: p.fg, fontFamily: 'monospace', fontSize: font.sm, lineHeight: 19 }}>{block.value}</Text></Pressable>
    ) : block.value === '' ? <View key={index} style={{ height: 6 }} /> : (
      <Text key={index} selectable style={[styles.line, { color: p.fg }, block.kind === 'heading' && styles.heading]}>
        {block.kind === 'list' ? '•  ' : ''}<Inline value={block.value} />
      </Text>
    ))}
    {folded ? <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={{ minHeight: touch.min, justifyContent: 'center' }}><Text style={{ color: p.fgMute, fontSize: font.sm }}>展开完整消息</Text></Pressable> : null}
  </View>
})

const styles = StyleSheet.create({
  body: { maxWidth: '100%', gap: 2 },
  line: { fontSize: font.base, lineHeight: 23 },
  heading: { fontSize: font.lg, fontWeight: '700', marginTop: space[2], marginBottom: space[1] },
  code: { borderWidth: 1, borderRadius: radius.md, padding: space[3], marginVertical: space[2] }
})
