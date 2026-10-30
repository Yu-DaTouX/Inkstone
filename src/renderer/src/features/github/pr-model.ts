import type {
  GhCheckNodeJson,
  GhPrCommentJson,
  GhPrDetailJson,
  GhPrFileJson,
  GhPrListItemJson,
  GhPrCommitJson,
  GhPrListState,
  GhPrReviewJson,
  GhPrReviewRequestJson,
  GhPrReviewThreadJson
} from '../../../../shared/github'

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type PrCheckState = 'pass' | 'fail' | 'pending'

export interface PrChecks {
  state: PrCheckState | 'none'
  total: number
  passed: number
  failed: number
  pending: number
}

export interface PrCheckItem {
  name: string
  state: PrCheckState
  url: string
  detail: string
}

export interface PrRow {
  number: number
  title: string
  author: string
  state: PrState
  isDraft: boolean
  head: string
  base: string
  url: string
  updatedAt: string
  reviewDecision: string
  additions: number
  deletions: number
  checks: PrChecks
  labels: string[]
}

export type PrMergeable = 'mergeable' | 'conflicting' | 'unknown'

export interface PrFileItem {
  path: string
  additions: number
  deletions: number
  patch: string
  key: string
}

export type PrReviewerState = 'approved' | 'changes' | 'commented' | 'pending' | 'dismissed'

export interface PrReviewer {
  name: string
  state: PrReviewerState
}

export interface PrTimelineItem {
  id: string
  kind: 'comment' | 'review' | 'commit'
  author: string
  at: string
  body: string
  review: string
}

export type PrSide = 'LEFT' | 'RIGHT'

export interface PrThreadComment {
  id: number
  author: string
  body: string
  at: string
  url: string
}

export interface PrThread {
  id: string
  path: string
  line: number
  startLine: number
  side: PrSide
  isResolved: boolean
  isOutdated: boolean
  comments: PrThreadComment[]
}

export interface PrDetail {
  number: number
  title: string
  author: string
  state: PrState
  body: string
  url: string
  head: string
  base: string
  createdAt: string
  updatedAt: string
  mergedAt: string
  closedAt: string
  reviewDecision: string
  mergeable: PrMergeable
  mergeState: string
  commitCount: number
  additions: number
  deletions: number
  changedFiles: number
  labels: string[]
  reviewers: PrReviewer[]
  checks: PrChecks
  checkItems: PrCheckItem[]
  files: PrFileItem[]
  timeline: PrTimelineItem[]
  threads: PrThread[]
  threadsTruncated: boolean
  threadsError: string
}

const NO_CHECKS: PrChecks = { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 }

const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  'ERROR'
])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function prStateOf(item: { state?: string; isDraft?: boolean }): PrState {
  const state = text(item.state).toUpperCase()
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return item.isDraft === true ? 'draft' : 'open'
}

function checkItemOf(node: GhCheckNodeJson): PrCheckItem | null {
  if (!node || typeof node !== 'object') return null
  const isStatus = node.__typename === 'StatusContext' || (!node.name && (!!node.context || !!node.state))
  if (isStatus) {
    const state = text(node.state).toUpperCase()
    const kind: PrCheckState = state === 'SUCCESS' ? 'pass' : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending'
    const name = text(node.context) || text(node.__typename) || 'status'
    return { name, state: kind, url: text(node.targetUrl), detail: text(node.description) }
  }
  const name = text(node.name) || text(node.__typename) || 'check'
  const status = text(node.status).toUpperCase()
  const conclusion = text(node.conclusion).toUpperCase()
  if (status !== '' && status !== 'COMPLETED') return { name, state: 'pending', url: text(node.detailsUrl), detail: status }
  const state: PrCheckState = FAIL_CONCLUSIONS.has(conclusion) ? 'fail' : PASS_CONCLUSIONS.has(conclusion) ? 'pass' : 'pending'
  return { name, state, url: text(node.detailsUrl), detail: conclusion || status }
}

export function normalizeChecks(rollup: unknown): { summary: PrChecks; items: PrCheckItem[] } {
  const nodes = Array.isArray(rollup) ? rollup : []
  const items: PrCheckItem[] = []
  for (const node of nodes) {
    const item = checkItemOf(node as GhCheckNodeJson)
    if (item) items.push(item)
  }
  if (!items.length) return { summary: { ...NO_CHECKS }, items }
  const passed = items.filter((item) => item.state === 'pass').length
  const failed = items.filter((item) => item.state === 'fail').length
  const pending = items.length - passed - failed
  const state: PrCheckState = failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass'
  return { summary: { state, total: items.length, passed, failed, pending }, items }
}

export function normalizePrRow(item: GhPrListItemJson): PrRow {
  const { summary } = normalizeChecks(item.statusCheckRollup)
  return {
    number: count(item.number),
    title: text(item.title),
    author: text(item.author?.login),
    state: prStateOf(item),
    isDraft: item.isDraft === true,
    head: text(item.headRefName),
    base: text(item.baseRefName),
    url: text(item.url),
    updatedAt: text(item.updatedAt),
    reviewDecision: text(item.reviewDecision),
    additions: count(item.additions),
    deletions: count(item.deletions),
    checks: summary,
    labels: (item.labels ?? []).map((label) => text(label?.name)).filter(Boolean)
  }
}

export function mergeableOf(json: unknown): { mergeable: PrMergeable; mergeState: string } {
  const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const raw = text(record.mergeable).toUpperCase()
  const mergeable: PrMergeable = raw === 'MERGEABLE' ? 'mergeable' : raw === 'CONFLICTING' ? 'conflicting' : 'unknown'
  return { mergeable, mergeState: text(record.mergeStateStatus).toUpperCase() }
}

function unescapeGitPath(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

function pathFromDiffHeader(line: string): string {
  const rest = line.slice('diff --git '.length)
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(rest)
  if (quoted) return unescapeGitPath(quoted[2])
  const plain = /^a\/(.*) b\/(.*)$/.exec(rest)
  if (plain) return plain[2]
  const marker = rest.lastIndexOf(' b/')
  return marker >= 0 ? rest.slice(marker + 3) : ''
}

function pathFromMarker(line: string): string {
  const value = line.slice(4).trim()
  if (!value || value === '/dev/null') return ''
  return value.startsWith('b/') ? unescapeGitPath(value.slice(2)) : unescapeGitPath(value)
}

export interface PrDiffFile {
  path: string
  patch: string
}

export function splitDiffByFile(diff: string): PrDiffFile[] {
  if (!diff) return []
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff
  const out: PrDiffFile[] = []
  let path = ''
  let lines: string[] = []
  const flush = (): void => {
    if (!path && !lines.length) return
    out.push({ path, patch: `${lines.join('\n')}\n` })
  }
  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      path = pathFromDiffHeader(line)
      lines = [line]
      continue
    }
    if (!lines.length) continue
    if (!path && line.startsWith('+++ ')) path = pathFromMarker(line)
    lines.push(line)
  }
  flush()
  return out
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

export function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

export function prFileKey(repo: string, number: number, path: string, salt: string): string {
  return `${repo}#${number}:${path}:${hashText(salt)}`
}

function fileItemOf(
  repo: string,
  number: number,
  path: string,
  patch: string,
  meta: GhPrFileJson | undefined
): PrFileItem {
  const counted = countPatchLines(patch)
  const additions = typeof meta?.additions === 'number' ? meta.additions : counted.additions
  const deletions = typeof meta?.deletions === 'number' ? meta.deletions : counted.deletions
  const salt = patch || `${text(meta?.changeType)}:${additions}:${deletions}`
  return { path, additions, deletions, patch, key: prFileKey(repo, number, path, salt) }
}

function reviewerStateOf(state: string): PrReviewerState {
  const value = state.toUpperCase()
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes'
  if (value === 'DISMISSED') return 'dismissed'
  if (value === 'PENDING') return 'pending'
  return 'commented'
}

export function reviewersOf(
  latest: readonly GhPrReviewJson[] | null | undefined,
  requests: readonly GhPrReviewRequestJson[] | null | undefined
): PrReviewer[] {
  const out: PrReviewer[] = []
  for (const review of latest ?? []) {
    const name = text(review?.author?.login)
    if (name && !out.some((item) => item.name === name)) out.push({ name, state: reviewerStateOf(text(review.state)) })
  }
  for (const request of requests ?? []) {
    const name = text(request?.login) || text(request?.slug) || text(request?.name)
    if (name && !out.some((item) => item.name === name)) out.push({ name, state: 'pending' })
  }
  return out
}

export function timelineOf(
  comments: readonly GhPrCommentJson[] | null | undefined,
  reviews: readonly GhPrReviewJson[] | null | undefined,
  commits: readonly GhPrCommitJson[] | null | undefined = []
): PrTimelineItem[] {
  const items: PrTimelineItem[] = []
  ;(commits ?? []).forEach((commit, index) => {
    items.push({
      id: `k${index}:${text(commit.oid)}`,
      kind: 'commit',
      author: text(commit.authors?.[0]?.login) || text(commit.authors?.[0]?.name),
      at: text(commit.committedDate),
      body: text(commit.messageHeadline),
      review: text(commit.oid).slice(0, 7)
    })
  })
  const commentList = comments ?? []
  const reviewList = reviews ?? []
  commentList.forEach((comment, index) => {
    items.push({
      id: `c${index}:${text(comment.createdAt)}`,
      kind: 'comment',
      author: text(comment.author?.login),
      at: text(comment.createdAt),
      body: text(comment.body),
      review: ''
    })
  })
  reviewList.forEach((review, index) => {
    items.push({
      id: `r${index}:${text(review.submittedAt)}`,
      kind: 'review',
      author: text(review.author?.login),
      at: text(review.submittedAt),
      body: text(review.body),
      review: text(review.state).toUpperCase()
    })
  })
  return items.sort((a, b) => {
    const left = Date.parse(a.at) || 0
    const right = Date.parse(b.at) || 0
    return left - right
  })
}

function sideOf(value: unknown): PrSide {
  return value === 'LEFT' ? 'LEFT' : 'RIGHT'
}

export function threadsOf(threads: readonly GhPrReviewThreadJson[] | null | undefined): PrThread[] {
  const out: PrThread[] = []
  for (const thread of threads ?? []) {
    if (!thread || typeof thread !== 'object') continue
    const comments: PrThreadComment[] = []
    for (const comment of thread.comments ?? []) {
      if (!comment || typeof comment.databaseId !== 'number' || !(comment.databaseId > 0)) continue
      comments.push({ id: comment.databaseId, author: text(comment.author?.login), body: text(comment.body), at: text(comment.createdAt), url: text(comment.url) })
    }
    const path = text(thread.path)
    if (!path || !comments.length) continue
    const line = count(thread.line)
    const start = count(thread.startLine)
    out.push({
      id: text(thread.id) || `${path}:${comments[0].id}`,
      path,
      line,
      startLine: start > 0 && start < line ? start : line,
      side: sideOf(thread.side),
      isResolved: thread.isResolved === true,
      isOutdated: thread.isOutdated === true,
      comments
    })
  }
  return out
}

export function threadReplyTarget(thread: PrThread): number | null {
  return thread.comments[0]?.id ?? null
}

export function threadsForPath(threads: readonly PrThread[], path: string): PrThread[] {
  return threads.filter((thread) => thread.path === path).sort((a, b) => (a.line || Number.MAX_SAFE_INTEGER) - (b.line || Number.MAX_SAFE_INTEGER))
}

export function normalizePrDetail(json: GhPrDetailJson, options: { repo: string; diff: string }): PrDetail {
  const number = count(json.number)
  const { summary, items } = normalizeChecks(json.statusCheckRollup)
  const meta = new Map<string, GhPrFileJson>()
  for (const file of json.files ?? []) {
    const path = text(file?.path)
    if (path) meta.set(path, file)
  }
  const fromDiff = splitDiffByFile(options.diff)
  const files: PrFileItem[] = fromDiff.length
    ? fromDiff
        .filter((file) => file.path)
        .map((file) => fileItemOf(options.repo, number, file.path, file.patch, meta.get(file.path)))
    : [...meta.entries()].map(([path, file]) => fileItemOf(options.repo, number, path, '', file))
  return {
    number,
    title: text(json.title),
    author: text(json.author?.login),
    state: prStateOf(json),
    body: text(json.body),
    url: text(json.url),
    head: text(json.headRefName),
    base: text(json.baseRefName),
    createdAt: text(json.createdAt),
    updatedAt: text(json.updatedAt),
    mergedAt: text(json.mergedAt),
    closedAt: text(json.closedAt),
    reviewDecision: text(json.reviewDecision),
    ...mergeableOf(json),
    commitCount: Array.isArray(json.commits) ? json.commits.length : 0,
    additions: typeof json.additions === 'number' ? json.additions : files.reduce((sum, file) => sum + file.additions, 0),
    deletions: typeof json.deletions === 'number' ? json.deletions : files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: typeof json.changedFiles === 'number' ? json.changedFiles : files.length,
    labels: (json.labels ?? []).map((label) => text(label?.name)).filter(Boolean),
    reviewers: reviewersOf(json.latestReviews, json.reviewRequests),
    checks: summary,
    checkItems: items,
    files,
    timeline: timelineOf(json.comments, json.reviews, json.commits),
    threads: threadsOf(json.reviewThreads),
    threadsTruncated: json.reviewThreadsTruncated === true,
    threadsError: text(json.reviewThreadsError)
  }
}

export function filterByListState(rows: readonly PrRow[], state: GhPrListState): PrRow[] {
  return state === 'closed' ? rows.filter((row) => row.state !== 'merged') : [...rows]
}

export function filterPrRows(rows: readonly PrRow[], query: string): PrRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => {
    const haystack = [row.title, row.author, row.head, row.base, `#${row.number}`, String(row.number)]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
}

export type PrAgeUnit = 'now' | 'minute' | 'hour' | 'day' | 'long'

export function ageOf(iso: string, now: number): { unit: PrAgeUnit; value: number } {
  const at = Date.parse(iso)
  if (!iso || !Number.isFinite(at)) return { unit: 'long', value: 0 }
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return { unit: 'now', value: 0 }
  if (minutes < 60) return { unit: 'minute', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hour', value: hours }
  const days = Math.floor(hours / 24)
  if (days < 30) return { unit: 'day', value: days }
  return { unit: 'long', value: at }
}

export const VIEWED_LIMIT = 4000

export function parseViewed(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? 'null') as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function toggleViewed(list: readonly string[], key: string, on: boolean): string[] {
  if (!key) return [...list]
  const rest = list.filter((item) => item !== key)
  if (!on) return rest
  const next = [...rest, key]
  return next.length > VIEWED_LIMIT ? next.slice(next.length - VIEWED_LIMIT) : next
}

export function serializeViewed(list: readonly string[]): string {
  return JSON.stringify(list.slice(Math.max(0, list.length - VIEWED_LIMIT)))
}

export function viewedCount(list: readonly string[], keys: readonly string[]): number {
  const known = new Set(list)
  return keys.filter((key) => known.has(key)).length
}
