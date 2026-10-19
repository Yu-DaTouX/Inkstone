import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type {
  FileContentHit,
  FileContentSearchRequest,
  FileContentSearchResult,
  FileListingStatus
} from '../shared/ipc'

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'clj', 'cljs', 'cmake', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts',
  'cxx', 'dart', 'diff', 'env', 'erl', 'ex', 'exs', 'fish', 'fs', 'fsx', 'go', 'gql', 'gradle',
  'graphql', 'h', 'hcl', 'hh', 'hpp', 'hrl', 'htm', 'html', 'hxx', 'ini', 'java', 'jl', 'js',
  'json', 'json5', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'log', 'lua', 'm', 'markdown', 'md',
  'mdx', 'mjs', 'mm', 'mts', 'nim', 'nix', 'patch', 'php', 'pl', 'pm', 'po', 'pot', 'properties',
  'proto', 'ps1', 'py', 'r', 'rb', 'rs', 'rst', 'sass', 'scala', 'scss', 'sh', 'sql', 'srt',
  'styl', 'svelte', 'svg', 'swift', 'tex', 'text', 'tf', 'toml', 'ts', 'tsv', 'tsx', 'txt',
  'v', 'vb', 'vbs', 'vtt', 'vue', 'xml', 'yaml', 'yml', 'zsh'
])

const MAX_DIRS = 2000
const MAX_FILES = 2000
const MAX_HITS = 200
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LINE_CHARS = 200
const READ_BATCH = 8

function statusForError(error: unknown): FileListingStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  return 'error'
}

function nameSort(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function hasTraversal(value: string): boolean {
  return value.replace(/\\/g, '/').split('/').includes('..')
}

function isTextCandidate(name: string): boolean {
  const ext = extname(name).slice(1).toLowerCase()
  return ext.length > 0 && TEXT_EXTENSIONS.has(ext)
}

export async function searchFileContents(
  request: FileContentSearchRequest,
  signal?: AbortSignal
): Promise<FileContentSearchResult> {
  const requestedLimit = Number.isFinite(request.limit) ? Math.floor(request.limit as number) : MAX_HITS
  const limit = Math.max(1, Math.min(MAX_HITS, requestedLimit))
  const query = String(request.query ?? '').trim().toLocaleLowerCase()
  const baseResult = (
    status: FileContentSearchResult['status'],
    hits: FileContentHit[] = [],
    truncated = false,
    scannedFiles = 0,
    skippedFiles = 0
  ): FileContentSearchResult => ({ request, hits, status, truncated, scannedFiles, skippedFiles })

  if (!query) return baseResult('empty')

  const cwd = String(request.cwd ?? '')
  if (!cwd || !isAbsolute(cwd) || hasTraversal(cwd)) return baseResult('invalid')

  let root: string
  try {
    root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) return baseResult('invalid')
  } catch (error) {
    return baseResult(statusForError(error))
  }

  const files: Array<{ abs: string; rel: string; name: string }> = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  let scannedDirs = 0
  let hadReadError = false
  let truncated = false

  while (queue.length) {
    if (signal?.aborted) return baseResult('cancelled', [], truncated)
    if (scannedDirs >= MAX_DIRS) {
      truncated = true
      break
    }

    const current = queue.shift()!
    scannedDirs += 1
    let dirents: Dirent[]
    try {
      dirents = await readdir(current.abs, { withFileTypes: true })
    } catch (error) {
      if (current.rel === '') return baseResult(statusForError(error), [], truncated)
      hadReadError = true
      continue
    }

    const dirs: Dirent[] = []
    const entries: Dirent[] = []
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) dirs.push(entry)
      } else if (entry.isFile()) {
        entries.push(entry)
      }
    }
    dirs.sort(nameSort)
    entries.sort(nameSort)

    for (const dir of dirs) {
      if (scannedDirs + queue.length >= MAX_DIRS) {
        truncated = true
        break
      }
      queue.push({ abs: join(current.abs, dir.name), rel: current.rel ? `${current.rel}/${dir.name}` : dir.name })
    }
    if (truncated) break

    for (const entry of entries) {
      if (!isTextCandidate(entry.name)) continue
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      files.push({
        abs: join(current.abs, entry.name),
        rel: current.rel ? `${current.rel}/${entry.name}` : entry.name,
        name: entry.name
      })
    }
    if (truncated) break

    await new Promise<void>((resolveNext) => setImmediate(resolveNext))
  }

  const hits: FileContentHit[] = []
  let scannedFiles = 0
  let skippedFiles = 0

  for (let start = 0; start < files.length; start += READ_BATCH) {
    if (signal?.aborted) return baseResult('cancelled', hits, truncated, scannedFiles, skippedFiles)
    const batch = files.slice(start, start + READ_BATCH)
    const loaded = await Promise.all(
      batch.map(async (file) => {
        try {
          const info = await stat(file.abs)
          if (!info.isFile() || info.size > MAX_FILE_BYTES) return { file, skip: true as const }
          const buffer = await readFile(file.abs)
          if (buffer.includes(0)) return { file, skip: true as const }
          return { file, text: buffer.toString('utf8'), skip: false as const }
        } catch {
          return { file, skip: true as const }
        }
      })
    )

    let reachLimit = false
    for (const item of loaded) {
      if (item.skip) {
        skippedFiles += 1
        continue
      }
      scannedFiles += 1
      const lines = item.text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!line.toLocaleLowerCase().includes(query)) continue
        hits.push({ path: item.file.rel, name: item.file.name, line: index + 1, text: line.slice(0, MAX_LINE_CHARS) })
        if (hits.length >= limit) {
          truncated = true
          reachLimit = true
          break
        }
      }
      if (reachLimit) break
    }
    if (reachLimit) break
  }

  if (signal?.aborted) return baseResult('cancelled', hits, truncated, scannedFiles, skippedFiles)
  const status: FileContentSearchResult['status'] = hadReadError ? 'partial' : hits.length ? 'ok' : 'empty'
  return baseResult(status, hits, truncated, scannedFiles, skippedFiles)
}
