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

export function hasUnclosedFence(text: string): boolean {
  if (!text.includes('```') && !text.includes('~~~')) return false
  let fence = ''
  const lines = text.split('\n')
  for (const line of lines) {
    const match = FENCE_OPEN.exec(line)
    if (!match) {
      if (!fence && /^[ \t]+(?:```|~~~)/.test(line)) return lines.filter((item) => /^\s*(?:```|~~~)/.test(item)).length % 2 === 1
      continue
    }
    const marker = match[1]
    const rest = line.slice(match[0].length)
    if (fence) {
      if (marker[0] === fence[0] && marker.length >= fence.length && /^[ \t\r]*$/.test(rest)) fence = ''
    } else if (marker[0] !== '`' || !rest.includes('`')) {
      fence = marker
    }
  }
  return fence !== ''
}

export function prepareStreamingMarkdown(text: string, live: boolean): string {
  if (!live) return text
  const scan = scanTail(text)
  let out = text
  if (scan.inlineAt >= 0) {
    const tail = out.slice(scan.inlineAt)
    const marker = /^`+/.exec(tail)?.[0] ?? '`'
    out = holdPartialTable(tail.slice(marker.length).trim() ? `${out}${marker}` : out.slice(0, scan.inlineAt))
  }
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
const PARTIAL_IMAGE = /(?<!\\)((?:\\\\)*)!\[(?:\\[^\n]|[^\\[\]\n])*(?:\\|\](?:\((?:\\[^\n]|[^\\)\n])*\\?)?)?$/
const PARTIAL_LINK = /(?<!\\)((?:\\\\)*)\[((?:\\[^\n]|[^\\[\]\n])*)\]\((?:\\[^\n]|[^\\)\n])*\\?$/
const TABLE_ROW_START = /^ {0,3}\|/
const DELIMITER_CELL = /^:?-+:?$/

export function revealClosedMermaid(text: string, edge: number): number {
  const opener = '```mermaid\n'
  const offset = Math.max(0, edge - 4096)
  const prefix = text.slice(offset, edge)
  const gap = prefix.lastIndexOf('\n\n' + opener)
  const start = gap >= 0 ? offset + gap + 2 : !offset && prefix.startsWith(opener) ? 0 : -1
  if (start < 0) return edge
  const body = start + opener.length
  const end = /^ {0,3}`{3,}[ \t]*\r?\n/m.exec(text.slice(body, body + 4096))
  const closed = end ? body + end.index + end[0].length : edge
  if (closed <= edge) return edge
  const scan = scanTail(text.slice(0, start))
  return scan.fenceOpen || scan.mathAt >= 0 || scan.inlineAt >= 0 ? edge : closed
}

export function skipTableSeparator(text: string, edge: number): number {
  if (text[edge - 1] !== '\n') return edge
  const start = text.lastIndexOf('\n', edge - 2) + 1
  const end = text.indexOf('\n', edge)
  if (end < 0 || (start > 0 && text[start - 2] !== '\n')) return edge
  const header = text.slice(start, edge - 1)
  const separator = text.slice(edge, end)
  if (!TABLE_ROW_START.test(header) || !TABLE_ROW_START.test(separator)) return edge
  const cells = tableCells(separator)
  if (cells.length !== tableCells(header).length || !cells.every((cell) => DELIMITER_CELL.test(cell))) return edge
  const scan = scanTail(text.slice(0, edge))
  return scan.fenceOpen || scan.mathAt >= 0 || scan.inlineAt >= 0 ? edge : end + 1
}

export function skipLinkDestination(text: string, edge: number): number {
  const destination = /^https?:\/\/[^\s()\\]+\)/.exec(text.slice(edge, edge + 2048))
  if (!destination) return edge
  const prefix = text.slice(0, edge)
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (/^(?: {4}|\t)/.test(line) || PARTIAL_IMAGE.test(line)) return edge
  const scan = scanTail(prefix)
  return !scan.fenceOpen && scan.inlineAt < 0 && scan.mathAt < 0 && holdPartialLink(prefix) !== prefix
    ? edge + destination[0].length : edge
}

function holdPartialLink(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1
  const line = text.slice(lineStart)
  if (!line.includes('[')) return text
  const insideCode = (until: number): boolean => (line.slice(0, until).match(/`/g)?.length ?? 0) % 2 === 1
  const image = PARTIAL_IMAGE.exec(line)
  if (image && !insideCode(image.index)) return text.slice(0, lineStart + image.index) + image[1]
  if (!line.includes('](')) return text
  const match = PARTIAL_LINK.exec(line)
  if (!match || insideCode(match.index)) return text
  return text.slice(0, lineStart + match.index) + match[1] + match[2]
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
  if (!row.slice(row.indexOf('|') + 1).trim()) return text.slice(0, text.length - row.length)
  return text
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
