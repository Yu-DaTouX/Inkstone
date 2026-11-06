import { memo, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { font, lineHeight, mono, radius, space, touch, usePalette, weight } from '../theme'

function Inline({ value }: { value: string }) {
  const p = usePalette()
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g)
  return <Text>{parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <Text key={index} style={{ color: p.fg, fontWeight: weight.strong }}>{part.slice(2, -2)}</Text>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <Text key={index} style={{ fontFamily: mono, fontSize: font.sm, color: p.fg, backgroundColor: p.codeInline }}> {part.slice(1, -1)} </Text>
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) return /^https?:\/\//.test(link[2])
      ? <Text key={index} style={{ color: p.accent }} onPress={() => void Linking.openURL(link[2])}>{link[1]}</Text>
      : <Text key={index} style={{ color: p.accent }}>{link[1]}</Text>
    return <Text key={index}>{part}</Text>
  })}</Text>
}

export function CodeBlock({ value, lang, size = font.sm }: { value: string; lang?: string; size?: number }) {
  const p = usePalette()
  return <View style={[styles.code, { backgroundColor: p.sunken, borderColor: p.borderSoft }]}>
    {lang ? <Text style={[styles.lang, { color: p.fgMute }]}>{lang}</Text> : null}
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={styles.codeFrame} contentContainerStyle={styles.codeScroll}>
      <Text selectable style={{ color: p.fg, fontFamily: mono, fontSize: size, lineHeight: Math.round(size * 1.45) }}>{value}</Text>
    </ScrollView>
  </View>
}

export const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  const p = usePalette()
  const [expanded, setExpanded] = useState(false)
  const folded = !expanded && text.length > 8000
  const lines = (folded ? `${text.slice(0, 8000)}\n…` : text).replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<{ kind: 'text' | 'code' | 'heading' | 'list'; value: string; lang?: string }> = []
  let code: string[] | null = null
  let lang = ''
  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      if (code) { blocks.push({ kind: 'code', value: code.join('\n'), lang }); code = null }
      else { code = []; lang = fence[1] }
      continue
    }
    if (code) { code.push(line); continue }
    if (!line.trim()) { if (blocks.at(-1)?.kind !== 'text' || blocks.at(-1)?.value !== '') blocks.push({ kind: 'text', value: '' }); continue }
    const heading = /^#{1,3}\s+(.+)$/.exec(line)
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line)
    blocks.push({ kind: heading ? 'heading' : list ? 'list' : 'text', value: heading?.[1] ?? list?.[1] ?? line })
  }
  if (code) blocks.push({ kind: 'code', value: code.join('\n'), lang })
  return <View style={styles.body}>
    {blocks.map((block, index) => block.kind === 'code' ? (
      <CodeBlock key={index} value={block.value} lang={block.lang} />
    ) : block.value === '' ? <View key={index} style={{ height: 6 }} /> : (
      <Text key={index} selectable style={[styles.line, { color: p.fg }, block.kind === 'heading' && styles.heading]}>
        {block.kind === 'list' ? <Text style={{ color: p.fgMute }}>{'•  '}</Text> : null}<Inline value={block.value} />
      </Text>
    ))}
    {folded ? <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={{ minHeight: touch.min, justifyContent: 'center' }}><Text style={{ color: p.fgMute, fontSize: font.sm }}>展开完整消息</Text></Pressable> : null}
  </View>
})

const styles = StyleSheet.create({
  body: { maxWidth: '100%', gap: 2 },
  line: { fontSize: font.body, lineHeight: lineHeight.body },
  heading: { fontSize: 16, fontWeight: weight.strong, marginTop: space[3], marginBottom: space[1] },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingVertical: space[2], marginVertical: space[2] },
  codeFrame: { flexGrow: 0 },
  codeScroll: { paddingHorizontal: space[3], paddingVertical: space[1], alignItems: 'flex-start' },
  lang: { fontFamily: mono, fontSize: font.xs, paddingHorizontal: space[3] }
})
