import type { GhPrActionResult, GhPrFailure, GhPrInlineComment, GhPrListOptions, GhPrListState } from '../../../../shared/github'
import type { PrCheckItem, PrDetail, PrTimelineItem } from './pr-model'

export const PR_PAGE_SIZE = 30

export type PrDraftFilter = 'any' | 'draft' | 'ready'
export type PrReviewFilter = 'any' | 'none' | 'required' | 'approved' | 'changes_requested'
export type PrSortKey = 'updated' | 'created' | 'comments'

export interface PrListFilters {
  state: GhPrListState
  author: string
  labels: string[]
  draft: PrDraftFilter
  review: PrReviewFilter
  sort: PrSortKey
  direction: 'asc' | 'desc'
}

export const DEFAULT_LIST_FILTERS: PrListFilters = {
  state: 'open',
  author: '',
  labels: [],
  draft: 'any',
  review: 'any',
  sort: 'updated',
  direction: 'desc'
}

export function buildListOptions(filters: PrListFilters, page: number): GhPrListOptions {
  const options: GhPrListOptions = {
    state: filters.state,
    sort: filters.sort,
    direction: filters.direction,
    limit: PR_PAGE_SIZE * Math.max(1, Math.floor(page))
  }
  const author = filters.author.trim()
  if (author) options.author = author
  const labels = [...new Set(filters.labels.map((label) => label.trim()).filter(Boolean))]
  if (labels.length) options.labels = labels
  if (filters.draft !== 'any') options.draft = filters.draft === 'draft'
  if (filters.review !== 'any') options.review = filters.review
  return options
}

export function activeFilterCount(filters: PrListFilters): number {
  let count = 0
  if (filters.author.trim()) count++
  if (filters.labels.length) count++
  if (filters.draft !== 'any') count++
  if (filters.review !== 'any') count++
  return count
}

export function toggleLabel(labels: readonly string[], name: string): string[] {
  return labels.includes(name) ? labels.filter((item) => item !== name) : [...labels, name]
}

export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

export type PrMergeBlocker =
  | 'not-open'
  | 'draft'
  | 'conflict'
  | 'checks-failed'
  | 'checks-pending'
  | 'changes-requested'
  | 'review-required'
  | 'blocked'

export interface PrMergeVerdict {
  canMerge: boolean
  canAutoMerge: boolean
  blockers: PrMergeBlocker[]
}

export function mergeVerdict(detail: Pick<PrDetail, 'state' | 'checks' | 'reviewDecision' | 'mergeable' | 'mergeState'>): PrMergeVerdict {
  const blockers: PrMergeBlocker[] = []
  if (detail.state === 'merged' || detail.state === 'closed') return { canMerge: false, canAutoMerge: false, blockers: ['not-open'] }
  if (detail.state === 'draft') blockers.push('draft')
  if (detail.mergeable === 'conflicting') blockers.push('conflict')
  if (detail.checks.state === 'fail') blockers.push('checks-failed')
  if (detail.checks.state === 'pending') blockers.push('checks-pending')
  const review = detail.reviewDecision.toUpperCase()
  if (review === 'CHANGES_REQUESTED') blockers.push('changes-requested')
  else if (review === 'REVIEW_REQUIRED') blockers.push('review-required')
  if (detail.mergeState === 'BLOCKED' && !blockers.some((item) => item === 'review-required' || item === 'checks-failed' || item === 'checks-pending' || item === 'changes-requested')) blockers.push('blocked')
  const hard = blockers.filter((item) => item !== 'checks-pending' && item !== 'review-required' && item !== 'blocked')
  return {
    canMerge: blockers.length === 0,
    canAutoMerge: hard.length === 0,
    blockers
  }
}

export interface PendingComment {
  id: string
  path: string
  line: number
  startLine: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export function addPendingComment(list: readonly PendingComment[], input: Omit<PendingComment, 'id'>, id: string): PendingComment[] {
  const body = input.body.trim()
  if (!body || !input.path || !(input.line > 0)) return [...list]
  return [...list, { ...input, body, id }]
}

export function updatePendingComment(list: readonly PendingComment[], id: string, body: string): PendingComment[] {
  const next = body.trim()
  if (!next) return removePendingComment(list, id)
  return list.map((item) => (item.id === id ? { ...item, body: next } : item))
}

export function removePendingComment(list: readonly PendingComment[], id: string): PendingComment[] {
  return list.filter((item) => item.id !== id)
}

export function inlineCommentsOf(list: readonly PendingComment[]): GhPrInlineComment[] {
  return list.map((item) => ({
    path: item.path,
    line: item.line,
    side: item.side,
    body: item.startLine && item.startLine !== item.line ? `L${item.startLine}-L${item.line}\n\n${item.body}` : item.body
  }))
}

export function pendingStorageKey(repo: string, number: number): string {
  return `inkstone.github.pr.pending:${repo}#${number}`
}

export function parsePending(raw: string | null): PendingComment[] {
  try {
    const value = JSON.parse(raw ?? 'null') as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is PendingComment => {
      if (!item || typeof item !== 'object') return false
      const entry = item as Record<string, unknown>
      return (
        typeof entry.id === 'string' &&
        typeof entry.path === 'string' &&
        typeof entry.line === 'number' &&
        typeof entry.startLine === 'number' &&
        (entry.side === 'LEFT' || entry.side === 'RIGHT') &&
        typeof entry.body === 'string' &&
        entry.body.trim().length > 0
      )
    })
  } catch {
    return []
  }
}

interface SideLines {
  left: Map<number, string>
  right: Map<number, string>
}

function sideLinesOf(patch: string): SideLines {
  const left = new Map<number, string>()
  const right = new Map<number, string>()
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    const mark = line[0]
    const content = line.slice(1)
    if (mark === '+') right.set(newLine++, content)
    else if (mark === '-') left.set(oldLine++, content)
    else if (mark === ' ' || line === '') {
      left.set(oldLine++, content)
      right.set(newLine++, content)
    }
  }
  return { left, right }
}

export function inferCommentSide(patch: string, start: number, end: number, code: string): 'LEFT' | 'RIGHT' | null {
  const { left, right } = sideLinesOf(patch)
  const pick = (map: Map<number, string>): string | null => {
    const out: string[] = []
    for (let n = Math.min(start, end); n <= Math.max(start, end); n++) {
      const value = map.get(n)
      if (value !== undefined) out.push(value)
    }
    return out.length ? out.join('\n') : null
  }
  const rightCode = pick(right)
  const leftCode = pick(left)
  if (rightCode !== null && rightCode === code) return 'RIGHT'
  if (leftCode !== null && leftCode === code) return 'LEFT'
  if (right.has(Math.max(start, end))) return 'RIGHT'
  if (left.has(Math.max(start, end))) return 'LEFT'
  return null
}

export type PrActionPhase =
  | { phase: 'idle' }
  | { phase: 'running'; kind: string }
  | { phase: 'done'; kind: string; refreshFailed: boolean; pendingBranch: boolean }
  | { phase: 'failed'; kind: string; failure: GhPrFailure; recovery: 'retry' | 'refresh' | 'none' }

export type PrActionEvent =
  | { type: 'start'; kind: string }
  | { type: 'result'; result: GhPrActionResult }
  | { type: 'error'; message: string }
  | { type: 'reset' }

export function recoveryOf(failure: GhPrFailure): 'retry' | 'refresh' | 'none' {
  if (failure.code === 'timeout' || !failure.retrySafe) return 'refresh'
  if (failure.code === 'invalid-input' || failure.code === 'confirmation-required' || failure.code === 'gh-missing' || failure.code === 'not-authenticated') return 'none'
  return 'retry'
}

export function reduceAction(state: PrActionPhase, event: PrActionEvent): PrActionPhase {
  switch (event.type) {
    case 'start':
      return state.phase === 'running' ? state : { phase: 'running', kind: event.kind }
    case 'reset':
      return state.phase === 'running' ? state : { phase: 'idle' }
    case 'result': {
      if (state.phase !== 'running') return state
      const { result } = event
      if (result.ok) return { phase: 'done', kind: state.kind, refreshFailed: !!result.refreshFailure, pendingBranch: result.branchDeletion === 'pending' }
      const failure = result.failure ?? { code: 'other', message: '', hint: '', retrySafe: false }
      return { phase: 'failed', kind: state.kind, failure, recovery: recoveryOf(failure) }
    }
    case 'error': {
      if (state.phase !== 'running') return state
      const failure: GhPrFailure = { code: 'other', message: event.message, hint: '', retrySafe: false }
      return { phase: 'failed', kind: state.kind, failure, recovery: 'refresh' }
    }
  }
}

export function canStartAction(state: PrActionPhase): boolean {
  return state.phase !== 'running'
}

export function failureCause(failure: GhPrFailure): string {
  const parts: string[] = [`code: ${failure.code}`]
  const git = failure.gitFailure
  if (git) {
    parts.push(`git: ${git.code}`)
    if (git.message) parts.push(git.message)
    if (git.detail) parts.push(git.detail)
  }
  return parts.join('\n')
}

export interface CreateDefaultsInput {
  branch: string | null
  detached: boolean
  baseRef: string | null
  lastCommit?: string
  upstream: string | null
  unpushed: number | null
}

export interface CreateDefaults {
  head: string
  base: string
  title: string
  pushFirst: boolean
  blocked: 'detached' | 'default-branch' | null
}

export function baseBranchOf(baseRef: string | null): string {
  const value = (baseRef ?? '').trim()
  if (!value) return ''
  const slash = value.indexOf('/')
  if (slash > 0 && !value.startsWith('refs/')) {
    const remote = value.slice(0, slash)
    if (remote === 'origin' || remote === 'upstream') return value.slice(slash + 1)
  }
  return value.replace(/^refs\/heads\//, '')
}

export function titleFromBranch(branch: string): string {
  const leaf = branch.split('/').pop() ?? branch
  const words = leaf.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : ''
}

export function createDefaults(input: CreateDefaultsInput): CreateDefaults {
  const head = input.detached ? '' : (input.branch ?? '')
  const base = baseBranchOf(input.baseRef) || 'main'
  const blocked = !head ? 'detached' : head === base ? 'default-branch' : null
  const title = (input.lastCommit ?? '').split('\n')[0].trim() || titleFromBranch(head)
  const pushFirst = !input.upstream || (input.unpushed ?? 0) > 0
  return { head, base, title, pushFirst, blocked }
}

export interface CreateDraft {
  title: string
  body: string
  base: string
  head: string
  draft: boolean
  pushFirst: boolean
}

export function createProblem(draft: CreateDraft): 'title' | 'base' | 'head' | 'same' | null {
  if (!draft.head.trim()) return 'head'
  if (!draft.base.trim()) return 'base'
  if (draft.head.trim() === draft.base.trim()) return 'same'
  if (!draft.title.trim()) return 'title'
  return null
}

export function diffNames(current: readonly string[], next: readonly string[]): { add: string[]; remove: string[] } {
  const before = new Set(current)
  const after = new Set(next)
  return { add: [...after].filter((name) => !before.has(name)), remove: [...before].filter((name) => !after.has(name)) }
}

export function quoteReply(author: string, body: string, reply: string): string {
  const quoted = body
    .trim()
    .split('\n')
    .slice(0, 12)
    .map((line) => `> ${line}`)
    .join('\n')
  const head = author ? `> @${author}\n>\n` : ''
  return `${head}${quoted}\n\n${reply.trim()}`
}

export type AgentTask = 'explain' | 'fix-checks' | 'respond-reviews'

export interface AgentPromptLabels {
  intro: (number: number, title: string) => string
  link: string
  branches: (head: string, base: string) => string
  untrusted: string
  explain: string
  fixChecks: string
  failedChecks: string
  noFailedChecks: string
  respondReviews: string
  reviewNotes: string
  noReviewNotes: string
}

const LIMIT = 400

function clip(value: string, limit = LIMIT): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

export function failedChecksOf(items: readonly PrCheckItem[]): PrCheckItem[] {
  return items.filter((item) => item.state === 'fail')
}

export function reviewNotesOf(timeline: readonly PrTimelineItem[], limit = 8): PrTimelineItem[] {
  const notes = timeline.filter(
    (item) => (item.kind === 'review' && (item.review === 'CHANGES_REQUESTED' || item.body.trim())) || (item.kind === 'comment' && item.body.trim())
  )
  return notes.slice(Math.max(0, notes.length - limit))
}

export function agentPrompt(task: AgentTask, detail: Pick<PrDetail, 'number' | 'title' | 'url' | 'head' | 'base' | 'checkItems' | 'timeline'>, labels: AgentPromptLabels): string {
  const lines = [
    labels.intro(detail.number, clip(detail.title, 200)),
    `${labels.link}: ${detail.url}`,
    labels.branches(detail.head, detail.base),
    labels.untrusted,
    ''
  ]
  if (task === 'explain') {
    lines.push(labels.explain)
  } else if (task === 'fix-checks') {
    lines.push(labels.fixChecks)
    const failed = failedChecksOf(detail.checkItems)
    if (failed.length) {
      lines.push(labels.failedChecks)
      for (const item of failed) lines.push(`- ${clip(item.name, 160)}${item.detail ? ` (${clip(item.detail, 80)})` : ''}${item.url ? ` ${item.url}` : ''}`)
    } else {
      lines.push(labels.noFailedChecks)
    }
  } else {
    lines.push(labels.respondReviews)
    const notes = reviewNotesOf(detail.timeline)
    if (notes.length) {
      lines.push(labels.reviewNotes)
      for (const note of notes) {
        const tag = note.kind === 'review' && note.review ? ` [${note.review}]` : ''
        lines.push(`> @${note.author || 'ghost'}${tag}: ${clip(note.body) || '-'}`)
      }
    } else {
      lines.push(labels.noReviewNotes)
    }
  }
  return lines.join('\n')
}

export const FOLD_HIDE_SLACK = 32
export const FOLD_SHOW_TOP = 4

export interface CondenseInput {
  previous: boolean
  top: number
  foldHeight: number
  condensedHeight: number
}

export function nextCondensed(input: CondenseInput): { condensed: boolean; scrollTo: number | null } {
  if (input.foldHeight <= 0) return { condensed: input.previous, scrollTo: null }
  if (input.previous) return { condensed: !(input.top < FOLD_SHOW_TOP), scrollTo: null }
  if (input.top > input.foldHeight + FOLD_HIDE_SLACK) {
    const delta = input.foldHeight - input.condensedHeight
    return { condensed: true, scrollTo: Math.max(0, input.top - delta) }
  }
  return { condensed: false, scrollTo: null }
}

export function isBotLogin(login: string): boolean {
  const value = login.toLowerCase()
  return value.endsWith('[bot]') || value.endsWith('-bot') || value === 'github-actions'
}

export interface CommentView {
  items: PrTimelineItem[]
  total: number
  hidden: number
}

export function commentView(timeline: readonly PrTimelineItem[], options: { hideBots: boolean; order: 'newest' | 'oldest' }): CommentView {
  const all = timeline.filter((item) => item.kind !== 'commit' && (item.body.trim() || item.kind === 'review'))
  const shown = options.hideBots ? all.filter((item) => !isBotLogin(item.author)) : all
  const sorted = [...shown].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  if (options.order === 'newest') sorted.reverse()
  return { items: sorted, total: all.length, hidden: all.length - shown.length }
}
