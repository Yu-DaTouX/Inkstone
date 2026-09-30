/**
 * 轻量 Markdown 渲染。
 *
 * 只支持模型回答里真正会出现的几种：段落到空行、`#`～`###` 标题、`-` / `1.` 列表、`>` 引用、
 * `---` 分隔线、``` 代码块，以及行内的 `**粗**`、`*斜*`、`` `代码` ``。
 * 不引第三方依赖：手机上要的是可读，不是完整 CommonMark。
 */
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { font, mono, radius, space, weight } from '../theme'

type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean }

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[]; lang: string }
  | { kind: 'rule' }

/** 行内解析：粗体、行内代码、斜体。顺序即优先级。 */
function parseInline(line: string): Inline[] {
  const segments: Inline[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g
  let last = 0
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) segments.push({ text: line.slice(last, at) })
    const token = match[0]
    if (token.startsWith('**')) segments.push({ text: token.slice(2, -2), bold: true })
    else if (token.startsWith('`')) segments.push({ text: token.slice(1, -1), code: true })
    else segments.push({ text: token.slice(1, -1), italic: true })
    last = at + token.length
  }
  if (last < line.length) segments.push({ text: line.slice(last) })
  return segments
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1 }
      i += 1
      blocks.push({ kind: 'code', lines: body, lang })
      continue
    }
    if (!line.trim()) { i += 1; continue }
    if (/^---+$/.test(line.trim())) { blocks.push({ kind: 'rule' }); i += 1; continue }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); i += 1; continue }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,3}\s|^>|^\s*[-*]\s|^\s*\d+\.\s|^---+$/.test(lines[i])) {
      paragraph.push(lines[i]); i += 1
    }
    blocks.push({ kind: 'paragraph', lines: paragraph })
  }
  return blocks
}

function InlineText({ parts, color, codeBg, accent, style }: { parts: Inline[]; color: string; codeBg: string; accent: string; style?: object }) {
  return (
    <Text style={[{ color, fontSize: font.body, lineHeight: 24 }, style]}>
      {parts.map((part, index) => {
        if (part.code) return <Text key={index} style={{ fontFamily: mono, fontSize: font.sm, backgroundColor: codeBg, color: accent }}>{part.text}</Text>
        if (part.bold) return <Text key={index} style={{ fontWeight: weight.strong }}>{part.text}</Text>
        if (part.italic) return <Text key={index} style={{ fontStyle: 'italic' }}>{part.text}</Text>
        return <Text key={index}>{part.text}</Text>
      })}
    </Text>
  )
}

export function Markdown({ text, color, codeBg, accent }: { text: string; color: string; codeBg: string; accent: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        if (block.kind === 'rule') return <View key={index} style={[styles.rule, { backgroundColor: codeBg }]} />
        if (block.kind === 'code') {
          return (
            <View key={index} style={[styles.code, { backgroundColor: codeBg }]}>
              {block.lang ? <Text style={{ color: accent, fontSize: font.xs }}>{block.lang}</Text> : null}
              <Text style={{ color, fontFamily: mono, fontSize: font.sm, lineHeight: 20 }}>{block.lines.join('\n')}</Text>
            </View>
          )
        }
        if (block.kind === 'heading') {
          const size = block.level === 1 ? font.lg : block.level === 2 ? font.base : font.sm
          return <Text key={index} accessibilityRole="header" style={{ color, fontSize: size, fontWeight: weight.strong, lineHeight: size + 8 }}>{block.text}</Text>
        }
        if (block.kind === 'list') {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text style={{ color: accent, fontSize: font.body, lineHeight: 24 }}>{block.ordered ? `${itemIndex + 1}.` : '·'}</Text>
                  <InlineText parts={parseInline(item)} color={color} codeBg={codeBg} accent={accent} style={styles.listText} />
                </View>
              ))}
            </View>
          )
        }
        if (block.kind === 'quote') {
          return (
            <View key={index} style={[styles.quote, { borderLeftColor: accent }]}>
              <InlineText parts={parseInline(block.lines.join(' '))} color={color} codeBg={codeBg} accent={accent} />
            </View>
          )
        }
        return <InlineText key={index} parts={parseInline(block.lines.join(' '))} color={color} codeBg={codeBg} accent={accent} />
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space[2] },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space[1] },
  code: { borderRadius: radius.sm, padding: space[3], gap: space[1] },
  list: { gap: space[1] },
  listItem: { flexDirection: 'row', gap: space[2] },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 2, paddingLeft: space[3] }
})
