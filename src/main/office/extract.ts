/**
 * 从办公文件里提取结构化正文（需求稿 3.4）。
 *
 * 只读、不改文件；不做排版还原。各格式的取法：
 *   · docx：word/document.xml 的段落（表格按行，单元格用「 | 」连接）
 *   · xlsx：每个工作表一节，每个非空单元格一行「A1: 值」（公式显示为「=公式 → 结果」）
 *   · pptx：每页一节，按形状顺序取文字；备注页另起「备注」
 *   · pdf：复用资料库的 PDF 正文提取（扫描件、加密件会如实报告）
 */
import { OFFICE_MAX_LINES, type OfficeDocumentView, type OfficeFormat, type OfficeSection } from '../../shared/office'
import { parsePdfBuffer } from '../library-parser'
import { ZipReader } from './zip'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 取一段 XML 里某个标签的所有文本节点（例如 w:t、a:t） */
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

function docx(zip: ZipReader): OfficeSection[] {
  const xml = zip.text('word/document.xml')
  if (!xml) throw new Error('缺少 word/document.xml，不是有效的 Word 文档')
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) => {
    /* 表格：每行一段，单元格之间用「 | 」 */
    const rows = blocksOf(table, 'w:tr').map((row) =>
      blocksOf(row, 'w:tc').map((cell) => textsOf(cell, 'w:t').join('')).join(' | ')
    )
    return rows.map((row) => `<w:p><w:t>${row.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</w:t></w:p>`).join('')
  })
  const lines = blocksOf(body, 'w:p').map((paragraph) => textsOf(paragraph, 'w:t').join('').trim()).filter(Boolean)
  return [{ title: '正文', lines }]
}

function xlsx(zip: ZipReader): OfficeSection[] {
  const workbook = zip.text('xl/workbook.xml')
  if (!workbook) throw new Error('缺少 xl/workbook.xml，不是有效的表格文件')
  const shared = (zip.text('xl/sharedStrings.xml') ?? '')
  const strings = blocksOf(shared, 'si').map((item) => textsOf(item, 't').join(''))
  const rels = zip.text('xl/_rels/workbook.xml.rels') ?? ''
  const targetOf = new Map<string, string>()
  for (const rel of rels.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id && target) targetOf.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  const sections: OfficeSection[] = []
  for (const sheet of workbook.match(/<sheet\s[^>]*>/g) ?? []) {
    const name = attr(sheet, 'name') ?? '未命名'
    const relId = attr(sheet, 'r:id')
    const path = relId ? targetOf.get(relId) : null
    const xml = path ? zip.text(path) : null
    if (!xml) continue
    const lines: string[] = []
    for (const cell of xml.match(/<c\s[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const open = /<c\s[^>]*?\/?>/.exec(cell)?.[0] ?? ''
      const ref = attr(open, 'r')
      const type = attr(open, 't')
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1]
      const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cell)?.[1]
      const inline = textsOf(cell, 't').join('')
      let shown = type === 's' && value !== undefined ? strings[Number(value)] ?? '' : type === 'inlineStr' ? inline : value !== undefined ? decodeXml(value) : ''
      if (type === 'b') shown = shown === '1' ? 'TRUE' : 'FALSE'
      if (!shown && !formula) continue
      lines.push(`${ref ?? '?'}: ${formula ? `=${decodeXml(formula)} → ${shown}` : shown}`)
    }
    sections.push({ title: `工作表：${name}`, lines })
  }
  return sections
}

function slideNumber(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0)
}

function pptx(zip: ZipReader): OfficeSection[] {
  const slides = zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => slideNumber(a) - slideNumber(b))
  if (slides.length === 0) throw new Error('没有找到幻灯片，不是有效的 PPT 文件')
  return slides.map((path) => {
    const xml = zip.text(path) ?? ''
    const lines = blocksOf(xml, 'a:p').map((paragraph) => textsOf(paragraph, 'a:t').join('').trim()).filter(Boolean)
    const notesXml = zip.text(path.replace('slides/slide', 'notesSlides/notesSlide'))
    const notes = notesXml
      ? blocksOf(notesXml, 'a:p').map((paragraph) => textsOf(paragraph, 'a:t').join('').trim()).filter((line) => line && !/^\d+$/.test(line))
      : []
    return { title: `第 ${slideNumber(path)} 页`, lines: notes.length ? [...lines, '— 备注 —', ...notes] : lines }
  })
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

export function extractOffice(buffer: Buffer, format: OfficeFormat): OfficeDocumentView {
  try {
    if (format === 'pdf') {
      const parsed = parsePdfBuffer(buffer)
      if (parsed.status !== 'ok' || !parsed.text) return { ok: false, error: parsed.note }
      const { sections, truncated } = clamp([{ title: '正文', lines: parsed.text.split('\n').map((line) => line.trim()).filter(Boolean) }])
      return { ok: true, format, sections, truncated, note: parsed.note }
    }
    const zip = new ZipReader(buffer, 8 * 1024 * 1024, 16 * 1024 * 1024)
    const raw = format === 'docx' ? docx(zip) : format === 'xlsx' ? xlsx(zip) : pptx(zip)
    const { sections, truncated } = clamp(raw)
    const note = {
      docx: '按段落显示文字内容（表格按行），不含版式、图片与批注',
      xlsx: '按工作表列出非空单元格；公式显示为「=公式 → 上次保存的结果」，不在这里重算',
      pptx: '按页显示文字与备注，不含版式、图片与动画'
    }[format]
    return { ok: true, format, sections, truncated, note }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
