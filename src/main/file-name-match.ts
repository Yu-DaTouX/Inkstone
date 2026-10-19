export interface NameMatchScore {
  score: number
  positions: number[]
}

const SEGMENT_START = 9
const WORD_START = 7
const CAMEL_START = 6
const CONSECUTIVE = 8
const BASENAME = 3
const GAP = 1
const LENGTH_WEIGHT = 0.05
const NEG = -1e9

function isSeparator(ch: string): boolean {
  return ch === '-' || ch === '_' || ch === '.' || ch === ' '
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase()
}

function boundaryBonus(path: string, index: number): number {
  if (index === 0) return SEGMENT_START
  const prev = path[index - 1]
  if (prev === '/') return SEGMENT_START
  if (isSeparator(prev)) return WORD_START
  if (isUpper(path[index]) && isLower(prev)) return CAMEL_START
  return 0
}

export function normalizeQuery(query: string): string {
  return String(query ?? '').replace(/\\/g, '/').replace(/\s+/g, '')
}

export function matchName(rawQuery: string, path: string): NameMatchScore | null {
  const query = normalizeQuery(rawQuery)
  const n = query.length
  const m = path.length
  if (n === 0) return { score: -m * LENGTH_WEIGHT, positions: [] }
  if (n > m) return null
  const caseSensitive = query !== query.toLowerCase()
  const q = caseSensitive ? query : query.toLowerCase()
  const p = caseSensitive ? path : path.toLowerCase()

  let probe = 0
  for (let j = 0; j < m && probe < n; j += 1) if (p[j] === q[probe]) probe += 1
  if (probe < n) return null

  const baseStart = path.lastIndexOf('/') + 1
  const score = new Float64Array(n * m).fill(NEG)
  const from = new Int32Array(n * m).fill(-1)

  for (let j = 0; j < m; j += 1) {
    if (p[j] !== q[0]) continue
    score[j] = boundaryBonus(path, j) + (j >= baseStart ? BASENAME : 0) - Math.min(j, 20) * 0.1
  }

  for (let i = 1; i < n; i += 1) {
    const row = i * m
    const prevRow = (i - 1) * m
    let bestGap = NEG
    let bestGapIndex = -1
    for (let j = i; j < m; j += 1) {
      if (j - 2 >= i - 1) {
        const candidate = score[prevRow + j - 2]
        bestGap -= GAP
        if (candidate - GAP > bestGap) {
          bestGap = candidate - GAP
          bestGapIndex = j - 2
        }
      }
      if (p[j] !== q[i]) continue
      const bonus = boundaryBonus(path, j) + (j >= baseStart ? BASENAME : 0)
      const consecutive = score[prevRow + j - 1]
      let best = NEG
      let bestFrom = -1
      if (consecutive > NEG / 2) {
        best = consecutive + CONSECUTIVE + bonus
        bestFrom = j - 1
      }
      if (bestGap > NEG / 2 && bestGap + bonus > best) {
        best = bestGap + bonus
        bestFrom = bestGapIndex
      }
      if (bestFrom >= 0) {
        score[row + j] = best
        from[row + j] = bestFrom
      }
    }
  }

  const lastRow = (n - 1) * m
  let end = -1
  let top = NEG
  for (let j = n - 1; j < m; j += 1) {
    if (score[lastRow + j] > top) {
      top = score[lastRow + j]
      end = j
    }
  }
  if (end < 0) return null
  const positions = new Array<number>(n)
  let j = end
  for (let i = n - 1; i >= 0; i -= 1) {
    positions[i] = j
    j = from[i * m + j]
  }
  return { score: top - m * LENGTH_WEIGHT, positions }
}

export interface RankedName<T> {
  item: T
  path: string
  score: number
  positions: number[]
}

export function rankNames<T>(query: string, items: readonly T[], pathOf: (item: T) => string, limit: number): RankedName<T>[] {
  const ranked: RankedName<T>[] = []
  for (const item of items) {
    const path = pathOf(item)
    const match = matchName(query, path)
    if (match) ranked.push({ item, path, score: match.score, positions: match.positions })
  }
  ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return ranked.slice(0, Math.max(0, limit))
}
