/** 办公文件文字预览契约；宿主从实际文件提取正文。 */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface OfficeSection {
  /** 例如「第 3 页」「工作表：预算」「正文」 */
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

/** 一份文档最多展示这么多行（超大表格只看开头，界面注明已截断） */
export const OFFICE_MAX_LINES = 5_000
