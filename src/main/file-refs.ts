import { open, readFile, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { FilePreview, FilePreviewIssue, FileRefInfo, FileRefKind, FileTextResult, PreviewBytes } from '../shared/ipc'
import { isWithin, realRoot, scopedPath } from './file-path-gate'
import { decodeText, mediaOf } from './file-preview-classify'
import { MAX_PDF_BYTES } from './office/pdf-text'

const MAX_TEXT = 2 * 1024 * 1024
const WINDOW_TRIGGER_LINES = 2000
const WINDOW_BEFORE = 200
const WINDOW_AFTER = 400
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_FILE = 100 * 1024 * 1024

const TEXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.json5': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.less': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.cc': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/plain',
  '.cmd': 'text/plain',
  '.sql': 'text/x-sql',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.gitignore': 'text/plain',
  '.editorconfig': 'text/plain'
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

const granted = new Map<string, { size: number; mime: string; kind: FileRefKind; name: string; mtimeMs: number }>()

function classify(name: string): { mime: string; kind: FileRefKind } {
  const ext = extname(name).toLowerCase()
  if (IMAGE_MIME[ext]) return { mime: IMAGE_MIME[ext], kind: 'image' }
  if (ext === '.pdf') return { mime: 'application/pdf', kind: 'pdf' }
  if (TEXT_MIME[ext]) return { mime: TEXT_MIME[ext], kind: 'text' }
  if (!ext) return { mime: 'text/plain', kind: 'text' }
  return { mime: 'application/octet-stream', kind: 'binary' }
}

function fail(input: string, error: string): FileRefInfo {
  return { ok: false, input, path: '', name: basename(input) || input, size: 0, mimeType: '', kind: 'other', error }
}

export async function grantFile(input: string): Promise<FileRefInfo> {
  if (typeof input !== 'string' || !input.trim()) return fail(String(input ?? ''), '路径为空')
  if (!isAbsolute(input)) return fail(input, '只接受绝对路径')
  if (input.includes('\0')) return fail(input, '路径非法')

  let real: string
  try {
    real = await realpath(input)
  } catch {
    return fail(input, '文件不存在')
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return fail(input, '无法读取文件信息')
  }
  if (st.isDirectory()) return { ok: true, input, path: real, name: basename(real) || real, size: 0, mimeType: 'inode/directory', kind: 'other', isDirectory: true }
  if (!st.isFile()) return fail(input, '不是普通文件')

  const name = basename(real)
  const { mime, kind } = classify(name)
  const limit = kind === 'image' ? MAX_IMAGE : MAX_FILE
  if (st.size > limit) {
    return fail(input, `文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB，上限 ${limit / 1024 / 1024}MB）`)
  }

  granted.set(real, { size: st.size, mime, kind, name, mtimeMs: st.mtimeMs })
  return { ok: true, input, path: real, name, size: st.size, mimeType: mime, kind }
}

export async function grantFiles(inputs: unknown): Promise<FileRefInfo[]> {
  const list = Array.isArray(inputs) ? inputs.slice(0, 20) : []
  const out: FileRefInfo[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    out.push(await grantFile(raw))
  }
  return out
}

export async function readGrantedText(input: string): Promise<FileTextResult> {
  if (typeof input !== 'string' || !isAbsolute(input)) return { ok: false, error: '路径非法' }
  let real: string
  try {
    real = await realpath(input)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  const meta = granted.get(real)
  if (!meta) return { ok: false, error: '这个文件没有加入上下文，不能在预览里读取' }
  const now = await stat(real).catch(() => null)
  if (!now || now.size !== meta.size || now.mtimeMs !== meta.mtimeMs) {
    return { ok: false, error: '文件已变化，请重新添加到上下文' }
  }
  if (meta.kind === 'pdf') {
    return { ok: false, error: 'PDF 暂不支持文本预览，可以先用外部程序打开', size: meta.size }
  }
  if (meta.kind !== 'text') {
    return { ok: false, error: '二进制文件不支持文本预览', size: meta.size }
  }

  let buf: Buffer
  try {
    const size = Math.min(meta.size, MAX_TEXT)
    const fh = await open(real, 'r')
    try {
      buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    return { ok: false, error: '读取失败（可能没有权限）' }
  }
  const truncated = meta.size > MAX_TEXT
  return { ok: true, text: buf.toString('utf8'), truncated, size: meta.size }
}

export type PreviewTargetResult =
  | { ok: true; real: string; st: Stats; outsideRoot: boolean }
  | { ok: false; error: string; issue: FilePreviewIssue; dir?: string; creatable?: boolean }

export async function resolvePreviewTarget(rawPath: string, cwd: string): Promise<PreviewTargetResult> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, error: '路径为空', issue: 'invalid' }
  if (rawPath.includes('\0')) return { ok: false, error: '路径非法', issue: 'invalid' }

  const absolute = isAbsolute(rawPath)
  const root = cwd || process.cwd()
  let real: string
  let outsideRoot = false
  if (absolute) {
    try {
      real = await realpath(rawPath)
    } catch {
      return { ok: false, error: '文件不存在', issue: 'missing', dir: dirname(rawPath) }
    }
    const rootReal = await realRoot(root)
    outsideRoot = !rootReal || !isWithin(rootReal, real)
  } else {
    const scoped = await scopedPath(root, rawPath.split('/').join(sep))
    if (!scoped.ok) {
      if (scoped.reason === 'missing') {
        return { ok: false, error: '文件不存在', issue: 'missing', dir: dirname(scoped.lexical), ...(scoped.creatable ? { creatable: true } : {}) }
      }
      if (scoped.reason === 'root_missing') return { ok: false, error: '文件不存在', issue: 'missing', dir: dirname(join(root, rawPath)) }
      return { ok: false, error: '路径越界', issue: scoped.reason === 'invalid' ? 'invalid' : 'outside_root' }
    }
    real = scoped.real
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, error: '无法读取文件信息', issue: 'unreadable', dir: dirname(real) }
  }
  if (st.isDirectory()) return { ok: false, error: '这是文件夹', issue: 'directory', dir: dirname(real) }
  if (!st.isFile()) return { ok: false, error: '不是普通文件', issue: 'not_file', dir: dirname(real) }
  return { ok: true, real, st, outsideRoot }
}

export async function statPreview(
  rawPath: string,
  cwd: string
): Promise<{ ok: boolean; abs: string; mtimeMs: number; size: number; error?: string }> {
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) return { ok: false, abs: '', mtimeMs: 0, size: 0, error: resolved.error }
  return { ok: true, abs: resolved.real, mtimeMs: resolved.st.mtimeMs, size: resolved.st.size }
}

export async function readPreviewBytes(rawPath: string, cwd: string): Promise<PreviewBytes> {
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) {
    return {
      ok: false,
      abs: '',
      name: basename(rawPath) || rawPath,
      size: 0,
      error: resolved.error,
      issue: resolved.issue
    }
  }
  const { real, st } = resolved
  const name = basename(real)
  if (st.size > MAX_PDF_BYTES) {
    return {
      ok: false,
      abs: real,
      name,
      size: st.size,
      error: `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB`,
      issue: 'too_large'
    }
  }
  try {
    const bytes = await readFile(real)
    return {
      ok: true,
      abs: real,
      name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
  } catch {
    return { ok: false, abs: real, name, size: st.size, error: '读取失败（可能没有权限）', issue: 'unreadable' }
  }
}

export async function readPreview(
  rawPath: string,
  cwd: string,
  line?: number,
  lineEnd?: number
): Promise<FilePreview> {
  const resolved = await resolvePreviewTarget(rawPath, cwd)
  if (!resolved.ok) {
    return {
      ok: false,
      path: rawPath,
      abs: '',
      name: basename(rawPath) || rawPath,
      size: 0,
      kind: 'other',
      error: resolved.error,
      issue: resolved.issue,
      ...(resolved.dir ? { dir: resolved.dir } : {}),
      ...(resolved.creatable ? { creatable: true } : {})
    }
  }
  const { real, st } = resolved

  const name = basename(real)
  const { kind } = classify(name)
  const media = mediaOf(name)
  const base: FilePreview = {
    ok: true,
    path: rawPath,
    abs: real,
    name,
    size: st.size,
    mtimeMs: st.mtimeMs,
    kind,
    ...(resolved.outsideRoot ? { outsideRoot: true } : {}),
    ...(media ? { media, issue: 'media' as const } : {}),
    ...(line && Number.isFinite(line) ? { line } : {}),
    ...(line && lineEnd && Number.isFinite(lineEnd) && lineEnd > line ? { lineEnd } : {})
  }

  if (kind !== 'text') return base

  let bytes: Buffer
  try {
    const size = Math.min(st.size, MAX_TEXT)
    const fh = await open(real, 'r')
    try {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      bytes = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    return { ...base, error: '读取失败（可能没有权限）', issue: 'unreadable' }
  }

  const truncated = st.size > MAX_TEXT
  const decoded = decodeText(bytes, !truncated)
  if (decoded.issue === 'binary') return { ...base, kind: 'binary', issue: 'binary' }
  const issue = decoded.issue ?? (truncated ? ('too_large' as const) : undefined)
  const text = decoded.text
  const extra = { truncated, encoding: decoded.encoding, ...(issue ? { issue } : {}) }
  const allLines = text.split('\n')
  const anchor = line && Number.isFinite(line) ? line : undefined
  if (anchor && anchor > WINDOW_TRIGGER_LINES) {
    const start = Math.max(1, anchor - WINDOW_BEFORE)
    const end = Math.min(allLines.length, Math.max(anchor, lineEnd ?? anchor) + WINDOW_AFTER)
    return {
      ...base,
      ...extra,
      text: allLines.slice(start - 1, end).join('\n'),
      totalLines: allLines.length,
      ...(start > 1 ? { windowStart: start } : {}),
      windowEnd: end
    }
  }
  return { ...base, ...extra, text, totalLines: allLines.length }
}
