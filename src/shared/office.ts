export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface OfficeSection {
  title: string
  lines: string[]
}

export type OfficeDocumentView =
  | { ok: true; format: OfficeFormat; sections: OfficeSection[]; note: string; truncated: boolean }
  | { ok: false; error: string }

export function officeFormatOf(path: string): OfficeFormat | null {
  const match = /\.(docx|xlsx|pptx|pdf)$/i.exec(path)
  return match ? (match[1].toLowerCase() as OfficeFormat) : null
}

export const OFFICE_MAX_LINES = 5_000
