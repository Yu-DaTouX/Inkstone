import { FileFinder } from '@ff-labs/fff-node'
import type { GrepCursor } from '@ff-labs/fff-node'
import { homedir } from 'node:os'

const MAX_INDEXES = 3
const OPEN_TIMEOUT_MS = 20_000

export interface NameHit {
  path: string
  directory: boolean
}

export interface NameJob {
  root: string
  query: string
  limit: number
  directoriesOnly: boolean
}

export interface NamePage {
  hits: NameHit[]
  totalMatched: number
  totalFiles: number
  git: boolean
}

export interface GrepLine {
  path: string
  line: number
  text: string
}

export interface GrepJob {
  root: string
  query: string
  mode: 'plain' | 'regex'
  smartCase: boolean
  maxFileSize: number
  pageSize: number
  maxMatchesPerFile: number
  timeBudgetMs: number
  cursor: GrepCursor | null
}

export interface GrepPage {
  lines: GrepLine[]
  filesSearched: number
  totalFiles: number
  filteredFiles: number
  nextCursor: GrepCursor | null
  regexFallback?: string
}

interface IndexEntry {
  finder: FileFinder
  git: boolean
  usedAt: number
}

const entries = new Map<string, IndexEntry>()
const opening = new Map<string, Promise<IndexEntry>>()

function normalizeRoot(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

function destroyEntry(entry: IndexEntry): void {
  try {
    entry.finder.destroy()
  } catch {
  }
}

function evictOverflow(): void {
  while (entries.size > MAX_INDEXES) {
    let oldestKey = ''
    let oldestUsed = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.usedAt < oldestUsed) {
        oldestUsed = entry.usedAt
        oldestKey = key
      }
    }
    const victim = entries.get(oldestKey)
    if (!victim) return
    entries.delete(oldestKey)
    destroyEntry(victim)
  }
}

async function open(root: string): Promise<IndexEntry> {
  const atHome = normalizeRoot(root) === normalizeRoot(homedir())
  const created = FileFinder.create({ basePath: root, ...(atHome ? { enableHomeDirScanning: true } : {}) })
  if (!created.ok) throw new Error(created.error)
  const finder = created.value
  let scanned = false
  try {
    const waited = await finder.waitForScan(OPEN_TIMEOUT_MS)
    scanned = waited.ok && waited.value === true
  } catch {
    scanned = false
  }
  if (!scanned) {
    try {
      finder.destroy()
    } catch {
    }
    throw new Error('索引超时')
  }
  const health = finder.healthCheck(root)
  return { finder, git: health.ok && health.value.git.repositoryFound, usedAt: Date.now() }
}

async function indexFor(root: string): Promise<IndexEntry> {
  const existing = entries.get(root)
  if (existing) {
    existing.usedAt = Date.now()
    return existing
  }
  const inflight = opening.get(root)
  if (inflight) return inflight
  const task = open(root).then(
    (entry) => {
      opening.delete(root)
      entries.set(root, entry)
      evictOverflow()
      return entry
    },
    (error: unknown) => {
      opening.delete(root)
      throw error
    }
  )
  opening.set(root, task)
  return task
}

function trimParentDirectories(path: string): string {
  return path.replace(/\/+$/, '')
}

export async function runNameJob(job: NameJob): Promise<NamePage> {
  const entry = await indexFor(job.root)
  if (job.directoriesOnly) {
    const found = entry.finder.directorySearch(job.query, { pageSize: job.limit })
    if (!found.ok) throw new Error(found.error)
    const hits = found.value.items
      .map((item) => trimParentDirectories(item.relativePath))
      .filter((path) => path.length > 0)
      .map((path) => ({ path, directory: true }))
    return { hits, totalMatched: found.value.totalMatched, totalFiles: found.value.totalDirs, git: entry.git }
  }
  const found = entry.finder.fileSearch(job.query, { pageSize: job.limit })
  if (!found.ok) throw new Error(found.error)
  const hits = found.value.items.map((item) => ({ path: item.relativePath, directory: false }))
  return { hits, totalMatched: found.value.totalMatched, totalFiles: found.value.totalFiles, git: entry.git }
}

export async function runGrepJob(job: GrepJob): Promise<GrepPage> {
  const entry = await indexFor(job.root)
  await entry.finder.waitForIndexReady(OPEN_TIMEOUT_MS)
  const found = entry.finder.grep(job.query, {
    mode: job.mode,
    smartCase: job.smartCase,
    maxFileSize: job.maxFileSize,
    pageSize: job.pageSize,
    maxMatchesPerFile: job.maxMatchesPerFile,
    timeBudgetMs: job.timeBudgetMs,
    enforceTimeBudget: true,
    cursor: job.cursor
  })
  if (!found.ok) throw new Error(found.error)
  const page = found.value
  return {
    lines: page.items.map((item) => ({ path: item.relativePath, line: item.lineNumber, text: item.lineContent })),
    filesSearched: page.totalFilesSearched,
    totalFiles: page.totalFiles,
    filteredFiles: page.filteredFileCount,
    nextCursor: page.nextCursor,
    ...(page.regexFallbackError ? { regexFallback: page.regexFallbackError } : {})
  }
}

export function closeAllIndexes(): void {
  for (const entry of entries.values()) destroyEntry(entry)
  entries.clear()
}
