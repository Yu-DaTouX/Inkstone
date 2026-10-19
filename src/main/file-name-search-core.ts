import type { FileNameMatch } from '../shared/file-name-search'
import type { NameCandidate } from './file-name-candidates'
import { normalizeQuery, rankNames } from './file-name-match'

export const MAX_NAME_RESULTS = 50

function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}

function depthOf(path: string): number {
  let depth = 0
  for (let i = 0; i < path.length; i += 1) if (path[i] === '/') depth += 1
  return depth
}

export function searchCandidates(
  candidates: readonly NameCandidate[],
  rawQuery: string,
  rawLimit = MAX_NAME_RESULTS
): { matches: FileNameMatch[]; truncated: boolean } {
  const limit = Math.max(1, Math.min(MAX_NAME_RESULTS, Math.floor(rawLimit) || MAX_NAME_RESULTS))
  const query = normalizeQuery(rawQuery)
  const directoriesOnly = query.endsWith('/')
  const needle = directoriesOnly ? query.replace(/\/+$/, '') : query
  const pool = directoriesOnly ? candidates.filter((candidate) => candidate.directory) : candidates
  if (!needle) {
    const browse = [...pool].sort((a, b) => depthOf(a.path) - depthOf(b.path) || Number(b.directory) - Number(a.directory) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return {
      matches: browse.slice(0, limit).map((candidate) => ({ path: candidate.path, name: baseName(candidate.path), directory: candidate.directory, positions: [], score: 0 })),
      truncated: browse.length > limit
    }
  }
  const ranked = rankNames(needle, pool, (candidate) => candidate.path, limit + 1)
  return {
    matches: ranked.slice(0, limit).map((entry) => ({
      path: entry.path,
      name: baseName(entry.path),
      directory: entry.item.directory,
      positions: entry.positions,
      score: Math.round(entry.score * 100) / 100
    })),
    truncated: ranked.length > limit
  }
}
