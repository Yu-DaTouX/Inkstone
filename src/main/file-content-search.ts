import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UtilityProcess } from 'electron'
import { compileContentMatcher, splitContentLines } from './file-content-match'
import type { ContentLineMatch, ContentMatchJob, ContentMatchOutcome, ContentSearchOptions } from './file-content-match'
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

export type ContentMatchRunner = (job: ContentMatchJob, signal: AbortSignal) => Promise<ContentMatchOutcome>

export interface ContentWorkerReply {
  id: string
  matches?: ContentLineMatch[]
  longLines?: number
  limitReached?: boolean
  cancelled?: boolean
  error?: string
}

export interface ContentSearchRunOptions {
  signal?: AbortSignal
  now?: () => number
  match?: ContentMatchRunner
}

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
const READ_BATCH = 8
const DEADLINE_MS = 8000
const MATCH_BATCH_TIMEOUT_MS = 2000
const MAX_WORKERS = 2

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

interface WorkerSlot {
  proc: UtilityProcess
  pending: number
}

const slots = new Set<WorkerSlot>()

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'file-content-search-worker.js')
}

async function spawnSlot(): Promise<WorkerSlot> {
  const { utilityProcess } = await import('electron')
  const proc = utilityProcess.fork(workerPath(), [], { serviceName: 'Inkstone content search', stdio: 'ignore' })
  const slot: WorkerSlot = { proc, pending: 0 }
  proc.once('exit', () => slots.delete(slot))
  slots.add(slot)
  return slot
}

async function acquireSlot(): Promise<WorkerSlot> {
  let best: WorkerSlot | null = null
  for (const slot of slots) if (!best || slot.pending < best.pending) best = slot
  if (best && (best.pending === 0 || slots.size >= MAX_WORKERS)) return best
  return spawnSlot()
}

function killSlot(slot: WorkerSlot): void {
  slots.delete(slot)
  slot.proc.kill()
}

async function runInWorker(job: ContentMatchJob, signal: AbortSignal): Promise<ContentMatchOutcome> {
  const slot = await acquireSlot()
  const id = randomUUID()
  slot.pending += 1
  return new Promise<ContentMatchOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      slot.proc.off('message', onMessage)
      slot.proc.off('exit', onExit)
      signal.removeEventListener('abort', onAbort)
      slot.pending = Math.max(0, slot.pending - 1)
    }
    const onMessage = (message: ContentWorkerReply): void => {
      if (!message || message.id !== id) return
      cleanup()
      if (message.error) {
        reject(new Error(message.error))
        return
      }
      resolve({
        matches: message.matches ?? [],
        longLines: message.longLines ?? 0,
        limitReached: message.limitReached === true,
        ...(message.cancelled ? { cancelled: true } : {})
      })
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error('内容搜索进程已退出'))
    }
    const onTimeout = (): void => {
      cleanup()
      killSlot(slot)
      reject(new Error('timeout'))
    }
    const onAbort = (): void => {
      cleanup()
      slot.proc.postMessage({ type: 'cancel', id })
      reject(new Error('aborted'))
    }
    slot.proc.on('message', onMessage)
    slot.proc.once('exit', onExit)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(onTimeout, MATCH_BATCH_TIMEOUT_MS)
    slot.proc.postMessage({
      type: 'match',
      id,
      query: job.query,
      options: job.options,
      texts: job.texts,
      limit: job.limit
    })
  })
}

export function disposeContentSearch(): void {
  for (const slot of [...slots]) killSlot(slot)
}

export async function searchFileContents(
  request: FileContentSearchRequest,
  options: ContentSearchRunOptions = {}
): Promise<FileContentSearchResult> {
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? Date.now
  const match = options.match ?? runInWorker
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
  if (!compileContentMatcher(query, matchOptions)) return baseResult('pattern')

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

    const kept: Array<{ file: { abs: string; rel: string; name: string }; text: string }> = []
    for (const item of loaded) {
      if (item.skip) {
        skippedFiles += 1
        continue
      }
      scannedFiles += 1
      kept.push({ file: item.file, text: item.text })
    }
    if (!kept.length) continue

    const budget = Math.max(1, limit - hits.length)
    let outcome: ContentMatchOutcome
    try {
      outcome = await match({ query, options: matchOptions, texts: kept.map((item) => item.text), limit: budget }, signal)
    } catch (error) {
      if (signal?.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
      if ((error as Error | undefined)?.message === 'timeout') truncation.add('timeout')
      else hadReadError = true
      break
    }
    if (outcome.cancelled) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
    if (outcome.longLines > 0) truncation.add('long-line')

    const lineSets = kept.map((item) => splitContentLines(item.text))
    let reachLimit = outcome.limitReached
    for (const found of outcome.matches) {
      const item = kept[found.file]
      if (!item) continue
      const preview = contentPreview(lineSets[found.file][found.line - 1] ?? '', found.ranges)
      hits.push({
        path: item.file.rel,
        name: item.file.name,
        line: found.line,
        column: found.ranges[0][0] + 1,
        text: preview.text,
        ranges: preview.ranges
      })
      if (hits.length >= limit) {
        reachLimit = true
        break
      }
    }
    if (reachLimit) {
      truncation.add('result-limit')
      break
    }
  }

  if (signal?.aborted) return baseResult('cancelled', hits, scannedFiles, skippedFiles)
  const status: FileContentSearchResult['status'] = hadReadError ? 'partial' : hits.length ? 'ok' : 'empty'
  return baseResult(status, hits, scannedFiles, skippedFiles)
}
