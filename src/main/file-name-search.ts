import { realpath, stat } from 'node:fs/promises'
import type { FileNameMatch, FileNameSearchRequest, FileNameSearchResult } from '../shared/file-name-search'
import { matchName, normalizeQuery } from './file-name-match'
import { LatestPerScopeScheduler } from './file-name-scheduler'
import { disposeFileSearch, runFileSearchJob } from './file-search-host'
import type { NameJob, NamePage } from './file-search-index'

export const MAX_NAME_RESULTS = 50
const QUERY_LIMIT = 512
const DEADLINE_MS = 4000

interface NameScope extends NameJob {
  needle: string
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}

function splitQuery(raw: string): { query: string; needle: string; directoriesOnly: boolean } {
  const normalized = normalizeQuery(String(raw ?? '').slice(0, QUERY_LIMIT))
  const directoriesOnly = normalized.endsWith('/')
  return { query: normalized, needle: directoriesOnly ? normalized.replace(/\/+$/, '') : normalized, directoriesOnly }
}

function toMatch(needle: string, hit: NamePage['hits'][number]): FileNameMatch {
  const scored = matchName(needle, hit.path)
  return {
    path: hit.path,
    name: baseName(hit.path),
    directory: hit.directory,
    positions: scored ? scored.positions : [],
    score: scored ? Math.round(scored.score * 100) / 100 : 0
  }
}

const scheduler = new LatestPerScopeScheduler<NameScope, NamePage>(
  (job, signal) =>
    runFileSearchJob(
      { kind: 'name', root: job.root, query: job.query, limit: job.limit, directoriesOnly: job.directoriesOnly },
      signal
    ),
  { concurrency: 2, queueLimit: 2, deadlineMs: DEADLINE_MS }
)

export async function searchFileNames(scope: string, request: FileNameSearchRequest): Promise<FileNameSearchResult> {
  const empty = (error?: FileNameSearchResult['error']): FileNameSearchResult => ({
    request,
    matches: [],
    truncated: false,
    source: 'none',
    scanned: 0,
    ...(error ? { error } : {})
  })
  let root: string
  try {
    root = await realpath(request.cwd)
    if (!(await stat(root)).isDirectory()) return empty({ code: 'invalid' })
  } catch {
    return empty({ code: 'invalid' })
  }
  const limit = Math.max(1, Math.min(MAX_NAME_RESULTS, Math.floor(request.limit ?? MAX_NAME_RESULTS)))
  const { query, needle, directoriesOnly } = splitQuery(request.query)
  const outcome = await scheduler.submit(scope, { root, query, limit, directoriesOnly, needle })
  if (!outcome.ok) return empty({ code: outcome.code, ...(outcome.message ? { message: outcome.message } : {}) })
  const page = outcome.value
  const matches = page.hits.slice(0, limit).map((hit) => toMatch(needle, hit))
  return {
    request,
    matches,
    truncated: page.totalMatched > matches.length,
    source: page.git ? 'git' : 'walk',
    scanned: page.totalFiles
  }
}

export function disposeFileNameSearch(): void {
  scheduler.dispose()
  disposeFileSearch()
}
