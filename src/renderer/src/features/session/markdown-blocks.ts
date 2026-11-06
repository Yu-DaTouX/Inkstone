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

function closeLeadingEmphasis(text: string): string {
  const gap = text.lastIndexOf('\n\n')
  const start = gap < 0 ? 0 : gap + 2
  const paragraph = text.slice(start)
  if (!/^\*(?![*\s])/.test(paragraph) || /^`{3,}|^~{3,}/m.test(paragraph)) return text
  const stars = paragraph.replace(/\\\*/g, '').split('*').length - 1
  return stars % 2 === 1 ? `${text.trimEnd()}*` : text
}

export function prepareStreamingMarkdown(text: string, live: boolean): string {
  if (!live) return text
  const scan = scanTail(text)
  let out = text
  if (scan.inlineAt >= 0) out = out.slice(0, scan.inlineAt)
  else if (scan.mathAt >= 0) out = out.slice(0, scan.mathAt).replace(/\s+$/, '')
  else if (scan.fenceEdgeAt >= 0) out = out.slice(0, scan.fenceEdgeAt)
  else if (!scan.fenceOpen) out = closeOpenMarks(holdBareMarker(holdPartialTable(holdPartialLink(out))))
  return closeLeadingEmphasis(out)
}

interface TailScan {
  fenceOpen: boolean
  inlineAt: number
  mathAt: number
  fenceEdgeAt: number
}

function scanTail(text: string): TailScan {
  if (!text.includes('`') && !text.includes('~~~') && !text.includes('$$')) return { fenceOpen: false, inlineAt: -1, mathAt: -1, fenceEdgeAt: -1 }
  let fence: { char: string; size: number } | null = null
  let inline: { at: number; size: number } | null = null
  let mathAt = -1
  let fenceEdgeAt = -1
  let offset = 0
  for (const line of text.split('\n')) {
    const unterminated = offset + line.length === text.length
    const fenceLine = line.replace(/^(?: {0,3}>[ \t]?)+/, '').replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '')
    const marker = FENCE_OPEN.exec(fenceLine)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !fenceLine.slice(marker[0].length).trim()) fence = null
      else if (unterminated && /^ {0,3}(?:`+|~+)$/.test(line) && line.trim()[0] === fence.char && line.trim().length < fence.size) fenceEdgeAt = offset
    } else if (mathAt >= 0) {
      if (line.includes('$$')) mathAt = -1
    } else if (!line.trim()) {
      inline = null
    } else if (marker && !inline) {
      fence = { char: marker[1][0], size: marker[1].length }
      if (unterminated) fenceEdgeAt = offset
    } else if (!inline && DISPLAY_MATH_OPEN.test(line)) {
      if (line.split('$$').length % 2 === 0) mathAt = offset + line.indexOf('$$')
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
  return { fenceOpen: fence !== null, inlineAt: inline ? inline.at : -1, mathAt, fenceEdgeAt: fence !== null ? fenceEdgeAt : -1 }
}

const DISPLAY_MATH_OPEN = /^ {0,3}\$\$/
const BARE_MARKER = /^ {0,3}(?:[-*+]|>|#{1,6}|-{2}|\d{1,9}[.)]?)$/
const PARTIAL_IMAGE =/!\[[^\[\]\n]*(?:\](?:\([^)\n]*)?)?$/
const PARTIAL_LINK =/(!?)\[([^\[\]\n]*)\]\([^)\n]*$/
const TABLE_ROW_START = /^ {0,3}\|/
const DELIMITER_CELL = /^:?-+:?$/

function holdPartialLink(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1
  const line = text.slice(lineStart)
  if (!line.includes('[')) return text
  const insideCode = (until: number): boolean => (line.slice(0, until).match(/`/g)?.length ?? 0) % 2 === 1
  const image = PARTIAL_IMAGE.exec(line)
  if (image && !insideCode(image.index)) return text.slice(0, lineStart + image.index)
  if (!line.includes('](')) return text
  const match = PARTIAL_LINK.exec(line)
  if (!match || insideCode(match.index)) return text
  return text.slice(0, lineStart + match.index) + match[2]
}

function holdBareMarker(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1
  return BARE_MARKER.test(text.slice(lineStart)) ? text.slice(0, lineStart) : text
}

function closeOpenMarks(text: string): string {
  if (!text.includes('**') && !text.includes('~~')) return text
  const gap = text.lastIndexOf('\n\n')
  const start = gap < 0 ? 0 : gap + 2
  const masked = text.slice(start).replace(/\\[\s\S]|`[^`]*`/g, (piece) => ' '.repeat(piece.length))
  let out = text
  for (const mark of ['**', '~~']) {
    if (masked.split(mark).length % 2 === 1) continue
    const at = masked.lastIndexOf(mark)
    const after = masked.slice(at + 2)
    if (!after.trim()) out = out.slice(0, start + at).replace(/[ \t]+$/, '')
    else if (!/^\s/.test(after)) out = `${out}${mark}`
  }
  return out
}

function tableCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

function holdPartialTable(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  const complete = lines[lines.length - 1] === ''
  if (complete) lines.pop()
  let start = lines.length
  while (start > 0 && lines[start - 1].trim()) start -= 1
  const block = lines.slice(start)
  if (!block.length || !block.every((line) => TABLE_ROW_START.test(line))) return text
  const blockOffset = lines.slice(0, start).reduce((sum, line) => sum + line.length + 1, 0)
  const columns = tableCells(block[0]).length
  const delimiter = block.length >= 2 ? tableCells(block[1]) : null
  if (!delimiter || delimiter.length !== columns || !delimiter.every((cell) => DELIMITER_CELL.test(cell))) return text.slice(0, blockOffset)
  if (complete || block.length < 3) return text
  const row = block[block.length - 1]
  if (row.trimEnd().endsWith('|') && tableCells(row).length >= columns) return text
  return text.slice(0, text.length - row.length)
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
