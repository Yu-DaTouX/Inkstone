import {
  OFFICE_MAX_BLOCKS,
  OFFICE_MAX_LINES,
  OFFICE_MAX_SHEETS,
  OFFICE_MAX_SHEET_COLUMNS,
  OFFICE_MAX_SHEET_ROWS,
  OFFICE_MAX_SLIDES,
  type OfficeDocxBlock,
  type OfficeDocumentView,
  type OfficeFormat,
  type OfficeSection,
  type OfficeSheet,
  type OfficeSlide,
  type OfficeTextRun
} from '../../shared/office'
import { parsePdfBuffer } from './pdf-text'
import { ZipReader } from './zip'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const DOCX_TABLE_MAX_ROWS = 200
const DOCX_TABLE_MAX_COLUMNS = 30
const DOCX_LIST_MAX_ITEMS = 60
const DOCX_BLOCK_MAX_CHARS = 4_000
const SLIDE_MAX_BULLETS = 40
const CELL_MAX_CHARS = 2_000
const FALSE_VALUES = /^(?:0|false|off)$/i

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function textsOf(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) out.push(decodeXml(match[1]))
  return out
}

function blocksOf(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g')
  return xml.match(pattern) ?? []
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? decodeXml(match[1]) : null
}

function firstMatch(xml: string, pattern: RegExp): string {
  return pattern.exec(xml)?.[1] ?? ''
}

function runFlags(properties: string): { bold: boolean; italic: boolean } {
  const flag = (name: 'b' | 'i'): boolean => {
    const match = new RegExp(`<w:${name}(?:\\s+w:val="([^"]*)")?\\s*/>`).exec(properties)
    if (!match) return false
    return !FALSE_VALUES.test(match[1] ?? '1')
  }
  return { bold: flag('b'), italic: flag('i') }
}

function runText(run: string): string {
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/>/g
  let out = ''
  let match: RegExpExecArray | null
  while ((match = pattern.exec(run))) out += match[1] === undefined ? ' ' : decodeXml(match[1])
  return out
}

function docxRuns(paragraph: string): OfficeTextRun[] {
  const out: OfficeTextRun[] = []
  for (const run of blocksOf(paragraph, 'w:r')) {
    const text = runText(run)
    if (!text) continue
    const flags = runFlags(firstMatch(run, /(<w:rPr>[\s\S]*?<\/w:rPr>)/))
    const previous = out[out.length - 1]
    if (previous && !!previous.bold === flags.bold && !!previous.italic === flags.italic) {
      previous.text += text
      continue
    }
    out.push({ text, bold: flags.bold || undefined, italic: flags.italic || undefined })
  }
  return out
}

function paragraphText(paragraph: string): string {
  return docxRuns(paragraph)
    .map((run) => run.text)
    .join('')
    .trim()
}

function numberingFormats(zip: ZipReader): Map<string, Map<number, string>> {
  const xml = zip.text('word/numbering.xml')
  const byNumber = new Map<string, Map<number, string>>()
  if (!xml) return byNumber
  const abstractLevels = new Map<string, Map<number, string>>()
  for (const abstract of blocksOf(xml, 'w:abstractNum')) {
    const id = attr(/^<w:abstractNum\b[^>]*>/.exec(abstract)?.[0] ?? '', 'w:abstractNumId')
    if (!id) continue
    const levels = new Map<number, string>()
    for (const level of blocksOf(abstract, 'w:lvl')) {
      const index = Number(attr(/^<w:lvl\b[^>]*>/.exec(level)?.[0] ?? '', 'w:ilvl') ?? '0')
      const format = firstMatch(level, /<w:numFmt\s+w:val="([^"]*)"/) || 'bullet'
      levels.set(Number.isFinite(index) ? index : 0, format)
    }
    abstractLevels.set(id, levels)
  }
  for (const num of blocksOf(xml, 'w:num')) {
    const id = attr(/^<w:num\b[^>]*>/.exec(num)?.[0] ?? '', 'w:numId')
    const abstract = firstMatch(num, /<w:abstractNumId\s+w:val="([^"]*)"/)
    if (!id || !abstract) continue
    byNumber.set(id, abstractLevels.get(abstract) ?? new Map())
  }
  return byNumber
}

function headingLevelOf(properties: string): number {
  const style = firstMatch(properties, /<w:pStyle\s+w:val="([^"]*)"/).trim()
  const numbered = /^(?:heading|标题)\s*([1-6])$/i.exec(style)
  if (numbered) return Number(numbered[1])
  if (/^(?:title|标题)$/i.test(style)) return 1
  const outline = firstMatch(properties, /<w:outlineLvl\s+w:val="([0-8])"/)
  return outline === '' ? 0 : Math.min(6, Number(outline) + 1)
}

function listKindOf(properties: string, numbering: Map<string, Map<number, string>>): { ordered: boolean } | null {
  if (!/<w:numPr\b/.test(properties)) return null
  const numId = firstMatch(properties, /<w:numId\s+w:val="(\d+)"/)
  const level = Number(firstMatch(properties, /<w:ilvl\s+w:val="(\d+)"/) || '0')
  const format = numbering.get(numId)?.get(Number.isFinite(level) ? level : 0) ?? ''
  return { ordered: format !== '' && format !== 'bullet' && format !== 'none' }
}

function docxTable(table: string): OfficeDocxBlock {
  const rows = blocksOf(table, 'w:tr')
    .slice(0, DOCX_TABLE_MAX_ROWS)
    .map((row) =>
      blocksOf(row, 'w:tc')
        .slice(0, DOCX_TABLE_MAX_COLUMNS)
        .map((cell) =>
          blocksOf(cell, 'w:p')
            .map((paragraph) => paragraphText(paragraph))
            .filter(Boolean)
            .join(' ')
        )
    )
    .filter((row) => row.some((cell) => cell !== ''))
  return { kind: 'table', rows }
}

function docxBlocks(xml: string, numbering: Map<string, Map<number, string>>): OfficeDocxBlock[] {
  const body = firstMatch(xml, /<w:body\b[^>]*>([\s\S]*)<\/w:body>/) || xml
  const pattern = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const blocks: OfficeDocxBlock[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushList = (): void => {
    if (list && list.items.length) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    if (blocks.length >= OFFICE_MAX_BLOCKS) break
    const chunk = match[0]
    if (chunk.startsWith('<w:tbl')) {
      flushList()
      blocks.push(docxTable(chunk))
      continue
    }
    if (/^<w:p\b[^>]*\/>$/.test(chunk)) {
      flushList()
      continue
    }
    const properties = firstMatch(chunk, /(<w:pPr>[\s\S]*?<\/w:pPr>)/)
    const kind = listKindOf(properties, numbering)
    if (kind) {
      const item = paragraphText(chunk).slice(0, DOCX_BLOCK_MAX_CHARS)
      if (!item) continue
      if (list && list.ordered === kind.ordered && list.items.length < DOCX_LIST_MAX_ITEMS) list.items.push(item)
      else {
        flushList()
        list = { ordered: kind.ordered, items: [item] }
      }
      continue
    }
    flushList()
    const level = headingLevelOf(properties)
    if (level > 0) {
      const text = paragraphText(chunk).slice(0, DOCX_BLOCK_MAX_CHARS)
      if (text) blocks.push({ kind: 'heading', level, text })
      continue
    }
    const runs = docxRuns(chunk)
    const text = runs.map((run) => run.text).join('')
    if (text.trim()) {
      const withPicture = /<w:(?:drawing|pict)\b/.test(chunk) ? [...runs, { text: ' [图片]' }] : runs
      blocks.push({
        kind: 'paragraph',
        runs: withPicture
          .slice(0, 200)
          .map((run) => ({ ...run, text: run.text.slice(0, DOCX_BLOCK_MAX_CHARS) }))
      })
      continue
    }
    if (/<w:(?:drawing|pict)\b/.test(chunk)) blocks.push({ kind: 'paragraph', runs: [{ text: '[图片]' }] })
  }
  flushList()
  return blocks
}

function docxLines(blocks: OfficeDocxBlock[]): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.kind === 'heading') lines.push(block.text)
    else if (block.kind === 'paragraph') lines.push(block.runs.map((run) => run.text).join(''))
    else if (block.kind === 'list') lines.push(...block.items)
    else for (const row of block.rows) lines.push(row.join(' | '))
  }
  return lines.filter((line) => line.trim() !== '')
}

function cellShown(cell: string, strings: string[]): string {
  const open = /<c\s[^>]*?\/?>/.exec(cell)?.[0] ?? ''
  const type = attr(open, 't')
  const value = firstMatch(cell, /<v>([\s\S]*?)<\/v>/)
  const inline = textsOf(cell, 't').join('')
  let shown =
    type === 's' && value !== ''
      ? strings[Number(value)] ?? ''
      : type === 'inlineStr'
        ? inline
        : value !== ''
          ? decodeXml(value)
          : ''
  if (type === 'b') shown = shown === '1' ? 'TRUE' : 'FALSE'
  return shown.slice(0, CELL_MAX_CHARS)
}

function columnIndexOf(ref: string | null): number {
  const letters = /^([A-Z]+)/i.exec(ref ?? '')?.[1]?.toUpperCase() ?? ''
  let value = 0
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64)
  return letters ? value - 1 : -1
}

function rowIndexOf(ref: string | null): number {
  const digits = /(\d+)$/.exec(ref ?? '')?.[1]
  return digits ? Number(digits) - 1 : -1
}

function buildSheet(name: string, cells: { row: number; column: number; shown: string }[]): OfficeSheet {
  if (!cells.length) return { name, rows: [] }
  let firstRow = Infinity
  let firstColumn = Infinity
  let lastSeenRow = 0
  let lastSeenColumn = 0
  for (const cell of cells) {
    firstRow = Math.min(firstRow, cell.row)
    firstColumn = Math.min(firstColumn, cell.column)
    lastSeenRow = Math.max(lastSeenRow, cell.row)
    lastSeenColumn = Math.max(lastSeenColumn, cell.column)
  }
  const lastRow = firstRow + OFFICE_MAX_SHEET_ROWS - 1
  const lastColumn = firstColumn + OFFICE_MAX_SHEET_COLUMNS - 1
  const height = Math.min(OFFICE_MAX_SHEET_ROWS, lastSeenRow - firstRow + 1)
  const width = Math.min(OFFICE_MAX_SHEET_COLUMNS, lastSeenColumn - firstColumn + 1)
  const rows: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ''))
  let truncated = false
  for (const cell of cells) {
    if (cell.row > lastRow || cell.column > lastColumn) {
      truncated = true
      continue
    }
    const row = rows[cell.row - firstRow]
    if (row) row[cell.column - firstColumn] = cell.shown
  }
  while (rows.length && rows[rows.length - 1].every((value) => value === '')) rows.pop()
  const trimmedWidth = rows.reduce((widest, row) => {
    let last = row.length - 1
    while (last >= 0 && row[last] === '') last -= 1
    return Math.max(widest, last + 1)
  }, 0)
  for (const row of rows) row.length = trimmedWidth
  return { name, rows, startRow: firstRow + 1, startColumn: firstColumn, ...(truncated ? { truncated: true } : {}) }
}

function xlsx(zip: ZipReader): { sections: OfficeSection[]; sheets: OfficeSheet[] } {
  const workbook = zip.text('xl/workbook.xml')
  if (!workbook) throw new Error('缺少 xl/workbook.xml，不是有效的表格文件')
  const shared = zip.text('xl/sharedStrings.xml') ?? ''
  const strings = blocksOf(shared, 'si').map((item) => textsOf(item, 't').join(''))
  const rels = zip.text('xl/_rels/workbook.xml.rels') ?? ''
  const targetOf = new Map<string, string>()
  for (const rel of rels.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id && target) targetOf.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  const sections: OfficeSection[] = []
  const sheets: OfficeSheet[] = []
  for (const sheet of workbook.match(/<sheet\s[^>]*>/g) ?? []) {
    if (sheets.length >= OFFICE_MAX_SHEETS) break
    const name = attr(sheet, 'name') ?? '未命名'
    const relId = attr(sheet, 'r:id')
    const path = relId ? targetOf.get(relId) : null
    const xml = path ? zip.text(path) : null
    if (!xml) continue
    const lines: string[] = []
    const cells: { row: number; column: number; shown: string }[] = []
    let rowCursor = 0
    for (const rowBlock of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const rowNumber = rowIndexOf(attr(/^<row\b[^>]*>/.exec(rowBlock)?.[0] ?? '', 'r'))
      rowCursor = rowNumber >= 0 ? rowNumber : rowCursor
      for (const cell of rowBlock.match(/<c\s[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const open = /<c\s[^>]*?\/?>/.exec(cell)?.[0] ?? ''
        const ref = attr(open, 'r')
        const formula = firstMatch(cell, /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)
        const shown = cellShown(cell, strings)
        if (!shown && !formula) continue
        lines.push(`${ref ?? '?'}: ${formula ? `=${decodeXml(formula)} → ${shown}` : shown}`)
        const column = columnIndexOf(ref)
        cells.push({ row: rowNumber >= 0 ? rowNumber : rowCursor, column: column >= 0 ? column : 0, shown })
      }
      rowCursor += 1
    }
    sections.push({ title: `工作表：${name}`, lines })
    sheets.push(buildSheet(name, cells))
  }
  sections.push(...charts(zip))
  return { sections, sheets }
}

function charts(zip: ZipReader): OfficeSection[] {
  const paths = zip
    .names()
    .filter((path) => /^xl\/charts\/chart[^/]*\.xml$/.test(path))
    .sort((a, b) => xmlIndex(a) - xmlIndex(b))
  const out: OfficeSection[] = []
  for (const path of paths) {
    const xml = zip.text(path)
    if (!xml) continue
    const title = textsOf(blocksOf(xml, 'c:title')[0] ?? '', 'a:t').join('').trim() || path.slice('xl/charts/'.length)
    const lines: string[] = []
    for (const serie of blocksOf(xml, 'c:ser')) {
      const name = textsOf(blocksOf(serie, 'c:tx')[0] ?? '', 'c:v').join('').trim()
      const ranges = textsOf(serie, 'c:f').map((range) => range.trim()).filter(Boolean)
      if (!name && ranges.length === 0) continue
      lines.push(ranges.length ? `${name || '未命名系列'}: ${ranges.join(' , ')}` : name)
    }
    out.push({ title: `图表：${title}`, lines })
  }
  return out
}

function xmlIndex(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0)
}

function slideNotes(zip: ZipReader, path: string): string[] {
  const xml = zip.text(path.replace('slides/slide', 'notesSlides/notesSlide'))
  if (!xml) return []
  return blocksOf(xml, 'a:p')
    .map((paragraph) => textsOf(paragraph, 'a:t').join('').trim())
    .filter((line) => line !== '' && !/^\d+$/.test(line))
    .slice(0, SLIDE_MAX_BULLETS)
}

function slideOf(zip: ZipReader, path: string): OfficeSlide {
  const xml = zip.text(path) ?? ''
  const titles: string[] = []
  const bullets: string[] = []
  for (const shape of blocksOf(xml, 'p:sp')) {
    const placeholder = /<p:ph\b[^>]*\/?>/.exec(shape)?.[0] ?? ''
    const type = attr(placeholder, 'type') ?? ''
    const lines = blocksOf(shape, 'a:p')
      .map((paragraph) => textsOf(paragraph, 'a:t').join('').trim())
      .filter((line) => line !== '')
    if (!lines.length) continue
    if (type === 'title' || type === 'ctrTitle') titles.push(...lines)
    else bullets.push(...lines)
  }
  const title = titles.join(' ').trim() || bullets.shift() || ''
  const notes = slideNotes(zip, path)
  return {
    index: xmlIndex(path),
    title: title.slice(0, CELL_MAX_CHARS),
    bullets: bullets.slice(0, SLIDE_MAX_BULLETS).map((line) => line.slice(0, CELL_MAX_CHARS)),
    ...(notes.length ? { notes } : {})
  }
}

function pptx(zip: ZipReader): { sections: OfficeSection[]; slides: OfficeSlide[] } {
  const paths = zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => xmlIndex(a) - xmlIndex(b))
  if (paths.length === 0) throw new Error('没有找到幻灯片，不是有效的 PPT 文件')
  const slides = paths.slice(0, OFFICE_MAX_SLIDES).map((path) => slideOf(zip, path))
  const sections = slides.map((slide) => {
    const lines = slide.title ? [slide.title, ...slide.bullets] : [...slide.bullets]
    return { title: `第 ${slide.index} 页`, lines: slide.notes ? [...lines, '— 备注 —', ...slide.notes] : lines }
  })
  return { sections, slides }
}

function clamp(sections: OfficeSection[]): { sections: OfficeSection[]; truncated: boolean } {
  let budget = OFFICE_MAX_LINES
  let characters = 512 * 1024
  let truncated = false
  const out: OfficeSection[] = []
  for (const section of sections) {
    if (budget <= 0 || characters <= 0 || out.length >= OFFICE_MAX_LINES) {
      truncated = true
      break
    }
    const title = section.title.slice(0, Math.min(256, characters))
    if (title.length < section.title.length) truncated = true
    characters -= title.length
    const lines: string[] = []
    for (const line of section.lines.slice(0, budget)) {
      if (characters <= 0) { truncated = true; break }
      lines.push(line.slice(0, characters))
      if (line.length > characters) truncated = true
      characters -= lines[lines.length - 1].length
    }
    if (lines.length < section.lines.length) truncated = true
    budget -= lines.length
    out.push({ title, lines })
  }
  return { sections: out, truncated }
}

const NOTES: Record<OfficeFormat, string> = {
  docx: '按段落显示文字内容（表格按行），不含版式、图片与批注',
  xlsx: '按工作表列出非空单元格；公式显示为「=公式 → 上次保存的结果」，不在这里重算',
  pptx: '按页显示文字与备注，不含版式、图片与动画',
  pdf: '按页提取文字，不含版式与图片'
}

export async function extractOffice(buffer: Buffer, format: OfficeFormat): Promise<OfficeDocumentView> {
  try {
    if (format === 'pdf') {
      const parsed = await parsePdfBuffer(buffer)
      if (parsed.status !== 'ok' || !parsed.text) return { ok: false, error: parsed.note }
      const { sections, truncated } = clamp([{ title: '正文', lines: parsed.text.split('\n').map((line) => line.trim()).filter(Boolean) }])
      return { ok: true, format, sections, truncated, note: parsed.note }
    }
    const zip = new ZipReader(buffer, 8 * 1024 * 1024, 16 * 1024 * 1024)
    if (format === 'docx') {
      if (!zip.has('word/document.xml')) throw new Error('缺少 word/document.xml，不是有效的 Word 文档')
      const blocks = docxBlocks(zip.text('word/document.xml') ?? '', numberingFormats(zip))
      const { sections, truncated } = clamp([{ title: '正文', lines: docxLines(blocks) }])
      return { ok: true, format, sections, truncated, note: NOTES.docx, blocks }
    }
    if (format === 'xlsx') {
      const { sections, sheets } = xlsx(zip)
      const { sections: clamped, truncated } = clamp(sections)
      return { ok: true, format, sections: clamped, truncated, note: NOTES.xlsx, sheets }
    }
    const { sections, slides } = pptx(zip)
    const { sections: clamped, truncated } = clamp(sections)
    return { ok: true, format, sections: clamped, truncated, note: NOTES.pptx, slides }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
