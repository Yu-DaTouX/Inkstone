import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { GrepCursor } from '@ff-labs/fff-node'
import { compileContentMatcher } from './file-content-match'
import type { ContentMatcher, ContentSearchOptions } from './file-content-match'
import { disposeFileSearch, runFileSearchJob } from './file-search-host'
import type { GrepJob, GrepPage } from './file-search-index'
import type {
  FileContentHit,
  FileContentSearchRequest,
  FileContentSearchResult,
  FileContentTruncation,
  FileListingStatus
} from '../shared/ipc'

export { compileContentMatcher, matchContentLines, splitContentLines } from './file-content-match'
export type {
  ContentLineMatch,
  ContentMatchJob,
  ContentMatchOutcome,
  ContentMatcher,
  ContentSearchOptions
} from './file-content-match'

export type ContentGrepJob = GrepJob
export type ContentGrepPage = GrepPage
export type ContentGrepRunner = (job: ContentGrepJob, signal: AbortSignal) => Promise<ContentGrepPage>

export interface ContentSearchRunOptions {
  signal?: AbortSignal
  now?: () => number
  grep?: ContentGrepRunner
}

export const MAX_CONTENT_HITS = 241
const MAX_FILE_BYTES = 1024 * 1024
const MAX_MATCHES_PER_FILE = 200
const MIN_PAGE_SIZE = 50
const MAX_PAGES = 40
const PREVIEW_BEFORE = 160
const PREVIEW_CHARS = 700
const DEADLINE_MS = 8000
const GUARD_MS = 1500

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

function hasTraversal(value: string): boolean {
  return value.replace(/\\/g, '/').split('/').includes('..')
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}

function probeQuery(query: string, options: ContentSearchOptions): { query: string; mode: 'plain' | 'regex'; smartCase: boolean } {
  if (options.regexp) return { query: options.matchCase ? query : `(?i)${query}`, mode: 'regex', smartCase: false }
  if (options.matchCase) return { query, mode: 'plain', smartCase: false }
  return { query: query.toLowerCase(), mode: 'plain', smartCase: true }
}

function withGuard<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController()
  const forward = (): void => controller.abort(signal.reason ?? 'aborted')
  const timer = setTimeout(() => controller.abort('timeout'), ms)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  return run(controller.signal).finally(() => {
    clearTimeout(timer)
    signal.removeEventListener('abort', forward)
  })
}

function defaultRunner(job: ContentGrepJob, signal: AbortSignal): Promise<GrepPage> {
  return runFileSearchJob({ kind: 'grep', ...job }, signal)
}

export function disposeContentSearch(): void {
  disposeFileSearch()
}

export async function searchFileContents(
  request: FileContentSearchRequest,
  options: ContentSearchRunOptions = {}
): Promise<FileContentSearchResult> {
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? Date.now
  const runner = options.grep ?? defaultRunner
  const requestedLimit = Number.isFinite(request.limit) ? Math.floor(request.limit as number) : MAX_CONTENT_HITS
  const limit = Math.max(1, Math.min(MAX_CONTENT_HITS, requestedLimit))
  const query = String(request.query ?? '').trim()
  const matchOptions: ContentSearchOptions = {
    matchCase: request.matchCase === true,
    wholeWord: request.wholeWord === true,
    regexp: request.regexp === true
  }
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
  const matcher: ContentMatcher | null = compileContentMatcher(query, matchOptions)
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
  const probe = probeQuery(query, matchOptions)
  const hits: FileContentHit[] = []
  let scannedFiles = 0
  let skippedFiles = 0
  let failed = false
  let cursor: GrepCursor | null = null

  for (let page = 0; ; page += 1) {
    if (signal.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
    if (now() > deadline) {
      truncation.add('timeout')
      break
    }
    if (page >= MAX_PAGES) {
      truncation.add('scan-limit')
      break
    }
    const budget = Math.max(1, deadline - now())
    let outcome: GrepPage
    try {
      outcome = await withGuard(
        (guardSignal) =>
          runner(
            {
              root,
              query: probe.query,
              mode: probe.mode,
              smartCase: probe.smartCase,
              maxFileSize: MAX_FILE_BYTES,
              pageSize: Math.max(MIN_PAGE_SIZE, limit - hits.length),
              maxMatchesPerFile: MAX_MATCHES_PER_FILE,
              timeBudgetMs: budget,
              cursor
            },
            guardSignal
          ),
        signal,
        DEADLINE_MS + GUARD_MS
      )
    } catch (error) {
      if (signal.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
      if ((error as Error | undefined)?.message === 'timeout') truncation.add('timeout')
      else failed = true
      break
    }
    if (outcome.regexFallback) return baseResult('pattern')
    scannedFiles += outcome.filesSearched
    skippedFiles = Math.max(skippedFiles, outcome.totalFiles - outcome.filteredFiles)

    let reached = false
    for (const line of outcome.lines) {
      if (matcher.skips(line.text)) {
        truncation.add('long-line')
        continue
      }
      const ranges = matcher.match(line.text)
      if (!ranges.length) continue
      const preview = contentPreview(line.text, ranges)
      hits.push({
        path: line.path,
        name: baseName(line.path),
        line: line.line,
        column: ranges[0][0] + 1,
        text: preview.text,
        ranges: preview.ranges
      })
      if (hits.length >= limit) {
        reached = true
        break
      }
    }
    if (reached) {
      truncation.add('result-limit')
      break
    }
    if (!outcome.nextCursor) break
    cursor = outcome.nextCursor
  }

  if (signal.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
  const status: FileContentSearchResult['status'] = failed ? 'partial' : hits.length ? 'ok' : 'empty'
  return baseResult(status, hits, scannedFiles, skippedFiles)
}
