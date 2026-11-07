import { pick } from '../../../src/shared/ui-lang'
import { memo, useMemo, useState } from 'react'
import { parseMessageBlocks } from '../messageBlocks'
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { isVisualDataLang, parseVisualBlock, type VisualBlock } from '../../../src/shared/visual-blocks'
import { font, lineHeight, mono, radius, space, touch, usePalette, weight } from '../theme'

function Inline({ value }: { value: string }) {
  const p = usePalette()
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])\*(?![\s*])[^*\n]*?[^\s*]\*(?![\w*]))/g)
  return <Text>{parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <Text key={index} style={{ color: p.ink ?? p.fg, fontWeight: weight.bold }}>{part.slice(2, -2)}</Text>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={index} style={{ color: p.fgMute }}>{part.slice(1, -1)}</Text>
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

export function visualLines(block: VisualBlock): { title?: string; rows: Array<[string, string]>; foot?: string } {
  if (block.kind === 'chart') return { title: block.title, rows: block.labels.map((label, index) => [label, block.series.map((series) => `${block.series.length > 1 ? `${series.name} ` : ''}${series.values[index] ?? '–'}${block.unit ?? ''}`).join(' · ')]), foot: block.source }
  if (block.kind === 'stats') return { title: block.title, rows: block.items.map((item) => [item.label, [item.value, item.delta].filter(Boolean).join(' ')]), foot: block.source }
  if (block.kind === 'cards') return { title: block.title, rows: block.items.map((item) => [`${item.recommended ? '★ ' : ''}${item.title}`, [item.badge, item.description, item.meta].filter(Boolean).join(' · ')]) }
  if (block.kind === 'record') return { title: [block.title, block.badge].filter(Boolean).join(' · '), rows: block.fields.map((field) => [field.label, field.value]), foot: block.note }
  if (block.kind === 'flow') return { title: block.title, rows: block.steps.map((step, index) => [`${index + 1}. ${step.title}`, step.detail ?? '']), foot: block.result?.text ?? block.note }
  return { title: block.title, rows: block.steps.map((step, index) => [`${index + 1}. ${step.title}`, step.body]) }
}

function VisualFallback({ lang, value }: { lang: string; value: string }) {
  const p = usePalette()
  const parsed = isVisualDataLang(lang) ? parseVisualBlock(lang, value) : null
  if (!parsed?.ok) return <CodeBlock value={value} lang={lang} />
  const view = visualLines(parsed.block)
  return <View style={[styles.visual, { backgroundColor: p.sunken, borderColor: p.borderSoft }]}>
    {view.title ? <Text style={{ color: p.fg, fontSize: font.base, fontWeight: weight.strong }}>{view.title}</Text> : null}
    {view.rows.map(([label, detail], index) => <View key={index} style={styles.visualRow}>
      <Text style={{ flexShrink: 1, color: p.fg, fontSize: font.sm }}>{label}</Text>
      {detail ? <Text selectable style={{ flex: 1, textAlign: 'right', color: p.fgDim, fontSize: font.sm }}>{detail}</Text> : null}
    </View>)}
    {view.foot ? <Text style={{ color: p.fgMute, fontSize: font.xs }}>{view.foot}</Text> : null}
  </View>
}

function Table({ rows }: { rows: string[][] }) {
  const p = usePalette()
  const columns = Math.max(...rows.map((row) => row.length))
  return <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={[styles.table, { borderColor: p.borderSoft }]}>
    <View>
      {rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.tableRow, { borderTopColor: p.borderSoft, borderTopWidth: rowIndex ? StyleSheet.hairlineWidth : 0, backgroundColor: rowIndex ? undefined : p.sunken }]}>
        {Array.from({ length: columns }, (_, cellIndex) => <Text key={cellIndex} selectable style={[styles.cell, { color: rowIndex ? p.fg : p.fgDim, fontWeight: rowIndex ? weight.regular : weight.strong }]}><Inline value={row[cellIndex] ?? ''} /></Text>)}
      </View>)}
    </View>
  </ScrollView>
}

function BodyImage({ alt, url }: { alt: string; url: string }) {
  const p = usePalette()
  if (!/^https?:\/\//i.test(url)) return <Text style={{ color: p.fgMute, fontSize: font.sm }}>{pick(`［图片：${alt || url.split(/[\\/]/).pop()}］`, `[Image: ${alt || url.split(/[\\/]/).pop()}]`)}</Text>
  return <Image accessibilityLabel={alt || pick('回复中的图片', 'Image in reply')} source={{ uri: url }} resizeMode="contain" style={[styles.image, { backgroundColor: p.sunken }]} />
}

export const MessageBody = memo(function MessageBody({ text, selectable = true }: { text: string; selectable?: boolean }) {
  const p = usePalette()
  const [expanded, setExpanded] = useState(false)
  const folded = !expanded && text.length > 8000
  const blocks = useMemo(() => parseMessageBlocks(text, folded), [text, folded])
  return <View style={styles.body}>
    {blocks.map((block, index) => block.kind === 'code' ? (
      block.lang?.startsWith('yan-') ? <VisualFallback key={index} lang={block.lang} value={block.value} /> : <CodeBlock key={index} value={block.value} lang={block.lang} />
    ) : block.kind === 'table' ? <Table key={index} rows={block.rows} />
    : block.kind === 'image' ? <BodyImage key={index} alt={block.value} url={block.url} />
    : block.value === '' ? <View key={index} style={{ height: 6 }} /> : (
      <Text key={index} selectable={selectable} style={[styles.line, { color: p.fg }, block.kind === 'heading' && styles.heading]}>
        {block.kind === 'list' ? <Text style={{ color: p.fgMute }}>{/^\[[xX]\]\s/.test(block.value) ? '☑  ' : /^\[ \]\s/.test(block.value) ? '☐  ' : '•  '}</Text> : null}<Inline value={block.kind === 'list' ? block.value.replace(/^\[[ xX]\]\s/, '') : block.value} />
      </Text>
    ))}
    {folded ? <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={{ minHeight: touch.min, justifyContent: 'center' }}><Text style={{ color: p.fgMute, fontSize: font.sm }}>{pick('展开完整消息', 'Show full message')}</Text></Pressable> : null}
  </View>
})

const styles = StyleSheet.create({
  body: { maxWidth: '100%', gap: 2 },
  line: { fontSize: font.body, lineHeight: lineHeight.body },
  heading: { fontSize: 16, fontWeight: weight.strong, marginTop: space[3], marginBottom: space[1] },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingVertical: space[2], marginVertical: space[2] },
  codeFrame: { flexGrow: 0 },
  codeScroll: { paddingHorizontal: space[3], paddingVertical: space[1], alignItems: 'flex-start' },
  lang: { fontFamily: mono, fontSize: font.xs, paddingHorizontal: space[3] },
  visual: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space[3], gap: space[1], marginVertical: space[2], alignSelf: 'stretch' },
  visualRow: { flexDirection: 'row', gap: space[3], justifyContent: 'space-between' },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, marginVertical: space[2], flexGrow: 0 },
  tableRow: { flexDirection: 'row' },
  cell: { width: 140, paddingHorizontal: space[2], paddingVertical: space[1], fontSize: font.sm, lineHeight: 20 },
  image: { width: '100%', aspectRatio: 16 / 10, borderRadius: radius.md, marginVertical: space[2] }
})
