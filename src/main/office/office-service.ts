/**
 * 办公文件的预览与修改对比（需求稿 3.4）。
 *
 * 预览：读磁盘上的**当前文件**提取结构化正文。
 * 对比：「修改前」取 git 里最近一次提交的版本（HEAD），「修改后」取磁盘当前文件；
 * 文件没有被 git 跟踪（新建）时，修改前为空、整份内容标为新增。
 * 路径走与文件预览相同的校验链（realpath、必须在会话目录内），只读，不改文件。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { diffOfficeSections, officeFormatOf, type OfficeCompareResult, type OfficeDocumentView } from '../../shared/office'
import { resolvePreviewTarget } from '../file-refs'
import { resolveRepo, safeRepoPath } from '../git-service'
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

/** git show HEAD:<path> 的原始字节（不能走字符串：会把二进制弄坏） */
function gitShowHead(root: string, repoPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', 'show', `HEAD:${repoPath}`],
      { cwd: root, encoding: 'buffer', maxBuffer: MAX_OFFICE_BYTES, windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(error ? null : (stdout as Buffer))
    )
  })
}

export async function compareOffice(rawPath: string, cwd: string): Promise<OfficeCompareResult> {
  const format = officeFormatOf(rawPath)
  if (!format) return { ok: false, error: '不是支持的办公文件（docx / xlsx / pptx / pdf）' }
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  if (resolved.st.size > MAX_OFFICE_BYTES) return { ok: false, error: '文件超过 64MB，请用系统程序打开' }
  const after = extractOffice(await readFile(resolved.real), format)
  if (!after.ok) return { ok: false, error: after.error }

  const repo = await resolveRepo(cwd)
  let before: OfficeDocumentView | null = null
  let baseLabel = '没有可对比的旧版本（不在 Git 仓库里），整份内容按新增显示'
  if (repo) {
    const repoPath = safeRepoPath(relative(repo.root, resolved.real).split(sep).join('/'))
    const old = repoPath ? await gitShowHead(repo.root, repoPath) : null
    if (old) {
      before = extractOffice(old, format)
      if (!before.ok) return { ok: false, error: `旧版本无法读取：${before.error}` }
      baseLabel = '对比最近一次提交（HEAD）与当前文件'
    } else {
      baseLabel = '这是新文件（最近一次提交里还没有），整份内容按新增显示'
    }
  }
  const { rows, added, removed } = diffOfficeSections(before?.ok ? before.sections : [], after.sections)
  return { ok: true, format, baseLabel, rows, added, removed, note: after.note }
}
