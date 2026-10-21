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
