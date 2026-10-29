export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface OfficeSection {
  title: string
  lines: string[]
}

export interface OfficeTextRun {
  text: string
  bold?: boolean
  italic?: boolean
}

export type OfficeDocxBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; runs: OfficeTextRun[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }

export interface OfficeSheet {
  name: string
  rows: string[][]
  startRow?: number
  startColumn?: number
  truncated?: boolean
}

export interface OfficeSlide {
  index: number
  title: string
  bullets: string[]
  notes?: string[]
}

export type OfficeDocumentView =
  | {
      ok: true
      format: OfficeFormat
      sections: OfficeSection[]
      note: string
      truncated: boolean
      blocks?: OfficeDocxBlock[]
      sheets?: OfficeSheet[]
      slides?: OfficeSlide[]
    }
  | { ok: false; error: string }

export function officeFormatOf(path: string): OfficeFormat | null {
  const match = /\.(docx|xlsx|pptx|pdf)$/i.exec(path)
  return match ? (match[1].toLowerCase() as OfficeFormat) : null
}

export const OFFICE_MAX_LINES = 5_000
export const OFFICE_MAX_SHEET_ROWS = 500
export const OFFICE_MAX_SHEET_COLUMNS = 50
export const OFFICE_MAX_SHEETS = 20
export const OFFICE_MAX_SLIDES = 500
export const OFFICE_MAX_BLOCKS = 3_000

export function officeColumnName(index: number): string {
  let value = Math.max(0, Math.floor(index))
  let name = ''
  while (true) {
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26) - 1
    if (value < 0) return name
  }
}
