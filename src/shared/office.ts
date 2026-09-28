/**
 * 办公文件的预览与修改对比（需求稿 3.4）：契约与纯逻辑。
 *
 * 预览必须对应**实际文件**：宿主从磁盘（或 git 里的旧版本）读出文件，按结构提取正文 ——
 * Word 按段落、表格按工作表与单元格、PPT 按页、PDF 按正文。这不是排版还原，
 * 界面上如实说明「只显示文字内容，不含版式与图片」。
 * 对比是提取后文字的逐行差异，不要求所有格式都有逐字差异界面。
 */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface OfficeSection {
  /** 例如「第 3 页」「工作表：预算」「正文」 */
  title: string
  lines: string[]
}

export type OfficeDocumentView =
  | { ok: true; format: OfficeFormat; sections: OfficeSection[]; note: string; truncated: boolean }
  | { ok: false; error: string }

export type OfficeDiffRow =
  | { type: 'section'; text: string }
  | { type: 'same' | 'add' | 'del'; text: string }

export type OfficeCompareResult =
  | { ok: true; format: OfficeFormat; baseLabel: string; rows: OfficeDiffRow[]; added: number; removed: number; note: string }
  | { ok: false; error: string }

export function officeFormatOf(path: string): OfficeFormat | null {
  const match = /\.(docx|xlsx|pptx|pdf)$/i.exec(path)
  return match ? (match[1].toLowerCase() as OfficeFormat) : null
}

/** 一份文档最多展示这么多行（超大表格只看开头，界面注明已截断） */
export const OFFICE_MAX_LINES = 5_000

/**
 * 按节对比两份提取结果：同名节逐行做 LCS 差异，只在一边存在的节整节标为新增 / 删除。
 * 行数很大时退化为「整节替换」，避免 O(n²) 卡住界面。
 */
export function diffOfficeSections(before: OfficeSection[], after: OfficeSection[]): { rows: OfficeDiffRow[]; added: number; removed: number } {
  const rows: OfficeDiffRow[] = []
  let added = 0
  let removed = 0
  const beforeByTitle = new Map(before.map((section) => [section.title, section]))
  const seen = new Set<string>()
  const push = (type: 'same' | 'add' | 'del', text: string): void => {
    rows.push({ type, text })
    if (type === 'add') added += 1
    if (type === 'del') removed += 1
  }
  const emitSection = (title: string, oldLines: string[], newLines: string[]): void => {
    const lines = diffLines(oldLines, newLines)
    if (!lines.some((line) => line.type !== 'same')) return
    rows.push({ type: 'section', text: title })
    for (const line of lines) push(line.type, line.text)
  }
  for (const section of after) {
    seen.add(section.title)
    emitSection(section.title, beforeByTitle.get(section.title)?.lines ?? [], section.lines)
  }
  for (const section of before) {
    if (!seen.has(section.title)) emitSection(section.title, section.lines, [])
  }
  return { rows, added, removed }
}

const LCS_LIMIT = 4_000_000

function diffLines(a: string[], b: string[]): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  if (a.length * b.length > LCS_LIMIT) {
    return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))]
  }
  /* 标准 LCS 表（行数已受上限约束） */
  const n = a.length
  const m = b.length
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}
