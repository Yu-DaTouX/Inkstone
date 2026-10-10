/**
 * 办公文件的预览（需求稿 3.4）：读磁盘上的**当前文件**提取结构化正文。
 * 路径走普通预览的 realpath/文件校验；相对路径限制在会话目录，绝对路径沿用显式本地预览语义。
 */
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officeFormatOf, type OfficeDocumentView } from '../../shared/office'
import { resolvePreviewTarget } from '../file-refs'

/** 与 PDF 解析同一个上限：再大就不在界面里提取 */
const MAX_OFFICE_BYTES = 64 * 1024 * 1024
let active = 0

export async function previewOffice(rawPath: string, cwd: string): Promise<OfficeDocumentView> {
  const format = officeFormatOf(rawPath)
  if (!format) return { ok: false, error: '不是支持的办公文件（docx / xlsx / pptx / pdf）' }
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.st.size > MAX_OFFICE_BYTES) return { ok: false, error: '文件超过 64MB，请用系统程序打开' }
  if (active >= 2) return { ok: false, error: '正在解析其他文件，请稍后重试' }
  active += 1
  try {
    return await new Promise<OfficeDocumentView>((resolve) => {
      const worker = new Worker(join(dirname(fileURLToPath(import.meta.url)), 'office-worker.js'), {
        workerData: { path: resolved.real, format }, resourceLimits: { maxOldGenerationSizeMb: 256 }
      })
      let settled = false
      const finish = (result: OfficeDocumentView): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, error: '解析超时，请用系统程序打开' }), 30_000)
      worker.once('message', (result: OfficeDocumentView) => finish(result))
      worker.once('error', () => finish({ ok: false, error: '文件解析失败，请用系统程序打开' }))
      worker.once('exit', () => finish({ ok: false, error: '文件解析中断，请用系统程序打开' }))
    })
  } catch {
    return { ok: false, error: '无法启动文件解析，请用系统程序打开' }
  } finally { active -= 1 }
}
