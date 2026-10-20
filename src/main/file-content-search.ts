import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import type {
  FileContentHit,
  FileContentSearchRequest,
  FileContentSearchResult,
  FileContentTruncation,
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
export const MAX_CONTENT_HITS = 241
const MAX_FILE_BYTES = 1024 * 1024
const PREVIEW_BEFORE = 160
const PREVIEW_CHARS = 700
const MAX_REGEX_LINE = 1000
const READ_BATCH = 8
const DEADLINE_MS = 8000

const WORD_CLASS = '[\\p{L}\\p{N}_]'
const WORD_CHAR = /[\p{L}\p{N}_]/u

export interface ContentSearchOptions {
  matchCase?: boolean
  wholeWord?: boolean
  regexp?: boolean
}

export interface ContentMatcher {
  skips(line: string): boolean
  match(line: string): Array<[number, number]>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileContentMatcher(query: string, options: ContentSearchOptions = {}): ContentMatcher | null {
  if (!query) return null
  if (!options.regexp && query.includes('\n')) return null
  const flags = options.matchCase ? 'gu' : 'giu'
  let source = options.regexp ? query : escapeRegExp(query)
  try {
    new RegExp(source, flags)
  } catch {
    return null
  }
  if (options.wholeWord) {
    const chars = [...query]
    const wordEdge = (char: string | undefined): boolean => !!options.regexp || (char !== undefined && WORD_CHAR.test(char))
    source = `${wordEdge(chars[0]) ? `(?<!${WORD_CLASS})` : ''}(?:${source})${wordEdge(chars[chars.length - 1]) ? `(?!${WORD_CLASS})` : ''}`
  }
  const pattern = new RegExp(source, flags)
  const regexp = !!options.regexp
  return {
    skips: (line) => regexp && line.length > MAX_REGEX_LINE,
    match: (line) => {
      const ranges: Array<[number, number]> = []
      pattern.lastIndex = 0
      for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
        if (found[0].length === 0) {
          pattern.lastIndex += (line.codePointAt(found.index) ?? 0) > 0xffff ? 2 : 1
          continue
        }
        ranges.push([found.index, found.index + found[0].length])
      }
      return ranges
    }
  }
}

function isLowSurrogate(line: string, index: number): boolean {
  const code = line.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff
}

export function contentPreview(line: string, ranges: ReadonlyArray<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  const first = ranges[0]?.[0] ?? 0
  let offset = Math.max(0, first - PREVIEW_BEFORE)
  if (offset > 0 && isLowSurrogate(line, offset)) offset -= 1
  let end = Math.min(line.length, offset + PREVIEW_CHARS)
  if (end < line.length && isLowSurrogate(line, end)) end -= 1
  return {
    text: line.slice(offset, end),
    ranges: ranges.filter(([start, stop]) => start >= offset && stop <= end).map(([start, stop]) => [start - offset, stop - offset])
  }
}

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
  signal?: AbortSignal,
  now: () => number = Date.now
): Promise<FileContentSearchResult> {
  const requestedLimit = Number.isFinite(request.limit) ? Math.floor(request.limit as number) : MAX_CONTENT_HITS
  const limit = Math.max(1, Math.min(MAX_CONTENT_HITS, requestedLimit))
  const query = String(request.query ?? '').trim()
  const truncation = new Set<FileContentTruncation>()
  const baseResult = (
    status: FileContentSearchResult['status'],
    hits: FileContentHit[] = [],
    scannedFiles = 0,
    skippedFiles = 0
  ): FileContentSearchResult => ({
    request,
    hits,
    status,
    truncated: truncation.size > 0,
    ...(truncation.size ? { truncation: [...truncation] } : {}),
    scannedFiles,
    skippedFiles
  })

  if (!query) return baseResult('empty')

  const matcher = compileContentMatcher(query, request)
  if (!matcher) return baseResult('pattern')

  const cwd = String(request.cwd ?? '')
  if (!cwd || !isAbsolute(cwd) || hasTraversal(cwd)) return baseResult('invalid')

  let root: string
  try {
    root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) return baseResult('invalid')
  } catch (error) {
    return baseResult(statusForError(error))
  }

  const deadline = now() + DEADLINE_MS
  const files: Array<{ abs: string; rel: string; name: string }> = []
  const queue: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  let scannedDirs = 0
  let hadReadError = false

  while (queue.length) {
    if (signal?.aborted) return baseResult('cancelled')
    if (scannedDirs >= MAX_DIRS) {
      truncation.add('scan-limit')
      break
    }

    const current = queue.shift()!
    scannedDirs += 1
    let dirents: Dirent[]
    try {
      dirents = await readdir(current.abs, { withFileTypes: true })
    } catch (error) {
      if (current.rel === '') return baseResult(statusForError(error))
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
        truncation.add('scan-limit')
        break
      }
      queue.push({ abs: join(current.abs, dir.name), rel: current.rel ? `${current.rel}/${dir.name}` : dir.name })
    }
    if (truncation.has('scan-limit')) break

    for (const entry of entries) {
      if (!isTextCandidate(entry.name)) continue
      if (files.length >= MAX_FILES) {
        truncation.add('scan-limit')
        break
      }
      files.push({
        abs: join(current.abs, entry.name),
        rel: current.rel ? `${current.rel}/${entry.name}` : entry.name,
        name: entry.name
      })
    }
    if (truncation.has('scan-limit')) break

    await new Promise<void>((resolveNext) => setImmediate(resolveNext))
  }

  const hits: FileContentHit[] = []
  let scannedFiles = 0
  let skippedFiles = 0

  for (let start = 0; start < files.length; start += READ_BATCH) {
    if (signal?.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
    if (now() > deadline) {
      truncation.add('timeout')
      break
    }
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
      const lines = item.text.split(/\r\n?|\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (matcher.skips(line)) {
          truncation.add('long-line')
          continue
        }
        const ranges = matcher.match(line)
        if (!ranges.length) continue
        const preview = contentPreview(line, ranges)
        hits.push({
          path: item.file.rel,
          name: item.file.name,
          line: index + 1,
          column: ranges[0][0] + 1,
          text: preview.text,
          ranges: preview.ranges
        })
        if (hits.length >= limit) {
          truncation.add('result-limit')
          reachLimit = true
          break
        }
      }
      if (reachLimit) break
    }
    if (reachLimit) break
  }

  if (signal?.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
  const status: FileContentSearchResult['status'] = hadReadError ? 'partial' : hits.length ? 'ok' : 'empty'
  return baseResult(status, hits, scannedFiles, skippedFiles)
}
