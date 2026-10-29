interface MarkdownBlock {
  text: string
  offset: number
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const DEFINITION = /^\[[^\]]+\]:/
const HTML_BLOCK = /^<\/?[a-zA-Z]/

function startsNewBlock(line: string): boolean {
  if (/^[ \t]/.test(line)) return false
  return !LIST_ITEM.test(line) && !DEFINITION.test(line) && !HTML_BLOCK.test(line)
}

export function prepareStreamingMarkdown(text: string, live: boolean): string {
  if (!live || !text.includes('`')) return text
  let fence: { char: string; size: number } | null = null
  let inline: { at: number; size: number } | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    const fenceLine = line.replace(/^(?: {0,3}>[ \t]?)+/, '').replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '')
    const marker = FENCE_OPEN.exec(fenceLine)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !fenceLine.slice(marker[0].length).trim()) fence = null
    } else if (!line.trim()) {
      inline = null
    } else if (marker && !inline) {
      fence = { char: marker[1][0], size: marker[1].length }
    } else if (inline || !/^(?: {4}|\t)/.test(line)) {
      for (let i = 0; i < line.length; i += 1) {
        if (!inline && line[i] === '\\') {
          i += 1
          continue
        }
        if (line[i] !== '`') continue
        let end = i + 1
        while (line[end] === '`') end += 1
        const size = end - i
        if (!inline) inline = { at: offset + i, size }
        else if (inline.size === size) inline = null
        i = end - 1
      }
    }
    offset += line.length + 1
  }
  return inline ? text.slice(0, inline.at) : text
}

export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let blockStart = 0
  let fence: { char: string; size: number } | null = null
  let sawBlank = false
  let pos = 0
  while (pos < text.length) {
    const end = text.indexOf('\n', pos)
    const lineEnd = end < 0 ? text.length : end
    const line = text.slice(pos, lineEnd)
    if (fence) {
      const close = FENCE_OPEN.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.size && !line.slice(close[0].length).trim()) fence = null
    } else if (!line.trim()) {
      sawBlank = true
    } else {
      if (sawBlank && end >= 0 && pos > blockStart && startsNewBlock(line)) {
        blocks.push({ text: text.slice(blockStart, pos), offset: blockStart })
        blockStart = pos
      }
      sawBlank = false
      const open = FENCE_OPEN.exec(line)
      if (open) fence = { char: open[1][0], size: open[1].length }
    }
    pos = lineEnd + 1
  }
  blocks.push({ text: text.slice(blockStart), offset: blockStart })
  return blocks
}
