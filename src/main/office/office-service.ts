/**
 * 办公文件的预览（需求稿 3.4）：读磁盘上的**当前文件**提取结构化正文。
 * 路径走与文件预览相同的校验链（realpath、必须在会话目录内），只读，不改文件。
 */
import { readFile } from 'node:fs/promises'
import { officeFormatOf, type OfficeDocumentView } from '../../shared/office'
import { resolvePreviewTarget } from '../file-refs'
import { extractOffice } from './extract'

/** 与 PDF 解析同一个上限：再大就不在界面里提取 */
const MAX_OFFICE_BYTES = 64 * 1024 * 1024

export async function previewOffice(rawPath: string, cwd: string): Promise<OfficeDocumentView> {
  const format = officeFormatOf(rawPath)
  if (!format) return { ok: false, error: '不是支持的办公文件（docx / xlsx / pptx / pdf）' }
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.st.size > MAX_OFFICE_BYTES) return { ok: false, error: '文件超过 64MB，请用系统程序打开' }
  return extractOffice(await readFile(resolved.real), format)
}
