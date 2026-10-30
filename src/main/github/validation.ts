import { isGhPrListState } from '../../shared/github'
import type { GhPrActionRequest, GhPrFailure, GhPrListOptions, GhPrListState } from '../../shared/github'
import { validateBranchName } from '../../shared/git-actions'
import { prFailure } from './command'

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function prNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 9_999_999
}

export function username(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('--') && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(value)
}

export function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 50 && value.trim() === value && /^[\p{L}\p{N}\p{M}\p{S} _.:/+()#&!?-]+$/u.test(value) && !value.startsWith('-')
}

function branch(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && !validateBranchName(value) && !value.startsWith('+')
}

function text(value: unknown, limit: number, empty = true): value is string {
  return typeof value === 'string' && value.length <= limit && !value.includes('\0') && (empty || value.trim().length > 0)
}

function names(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || Array.isArray(value) && value.length <= 100 && value.every(check)
}

function inlineRange(value: Record<string, unknown>): boolean {
  if (value.startSide !== undefined && !['LEFT', 'RIGHT'].includes(String(value.startSide))) return false
  if (value.startLine === undefined) return value.startSide === undefined
  if (!Number.isSafeInteger(value.startLine) || Number(value.startLine) < 1) return false
  return value.startSide !== undefined && value.startSide !== value.side || Number(value.startLine) <= Number(value.line)
}

export function validateAction(value: unknown): GhPrFailure | null {
  const invalid = () => prFailure('invalid-input', 'PR 操作参数不合法')
  if (!record(value) || typeof value.kind !== 'string') return invalid()
  if (value.kind !== 'create' && !prNumber(value.number)) return invalid()
  if (['merge', 'close', 'delete-branch'].includes(value.kind) && value.confirmed !== true) return prFailure('confirmation-required', '此操作需要调用方显式确认', true, '确认后传 confirmed: true')
  switch (value.kind as GhPrActionRequest['kind']) {
    case 'create': {
      const head = typeof value.head === 'string' ? value.head.split(':') : []
      if (!text(value.title, 256, false) || !text(value.body, 65_536) || !branch(value.base) || !(head.length === 1 && branch(head[0]) || head.length === 2 && username(head[0]) && branch(head[1]))) return invalid()
      if (value.draft !== undefined && typeof value.draft !== 'boolean') return invalid()
      if (value.pushFirst !== undefined && (head.length !== 1 || !record(value.pushFirst) || value.pushFirst.remote !== undefined && (typeof value.pushFirst.remote !== 'string' || !/^[a-z\d][a-z\d._-]{0,99}$/i.test(value.pushFirst.remote)) || value.pushFirst.setUpstream !== undefined && typeof value.pushFirst.setUpstream !== 'boolean')) return invalid()
      return null
    }
    case 'edit':
      if (value.title !== undefined && !text(value.title, 256, false) || value.body !== undefined && !text(value.body, 65_536)) return invalid()
      for (const key of ['addReviewers', 'removeReviewers']) if (!names(value[key], username)) return invalid()
      for (const key of ['addLabels', 'removeLabels']) if (!names(value[key], label)) return invalid()
      if (!['title', 'body', 'addReviewers', 'removeReviewers', 'addLabels', 'removeLabels'].some(key => value[key] !== undefined)) return invalid()
      for (const [add, remove] of [['addReviewers', 'removeReviewers'], ['addLabels', 'removeLabels']]) {
        if (Array.isArray(value[add]) && Array.isArray(value[remove]) && value[add].some(name => (value[remove] as unknown[]).includes(name))) return invalid()
      }
      return null
    case 'comment': return text(value.body, 65_536, false) ? null : invalid()
    case 'reply': return Number.isSafeInteger(value.commentId) && Number(value.commentId) > 0 && text(value.body, 65_536, false) ? null : invalid()
    case 'merge': return typeof value.method === 'string' && ['merge', 'squash', 'rebase'].includes(value.method) && (value.autoMerge === undefined || typeof value.autoMerge === 'boolean') && (value.deleteBranch === undefined || typeof value.deleteBranch === 'boolean') ? null : invalid()
    case 'review':
      if (typeof value.event !== 'string' || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(value.event) || !text(value.body, 65_536, false)) return invalid()
      if (value.comments !== undefined && (!Array.isArray(value.comments) || value.comments.length > 100 || !value.comments.every(c => record(c) && text(c.path, 1024, false) && !c.path.startsWith('/') && !c.path.includes('\\') && !c.path.split('/').some(part => part === '..' || part === '.') && !/^[a-z]:/i.test(c.path) && Number.isSafeInteger(c.line) && Number(c.line) > 0 && typeof c.side === 'string' && ['LEFT', 'RIGHT'].includes(c.side) && inlineRange(c) && text(c.body, 65_536, false)))) return invalid()
      return null
    case 'ready': case 'draft': case 'close': case 'reopen': case 'checkout': case 'delete-branch': return null
    default: return invalid()
  }
}

export function listArguments(value: GhPrListState | GhPrListOptions): { ok: true; args: string[]; limit: number } | { ok: false; failure: GhPrFailure } {
  const fail = () => ({ ok: false as const, failure: prFailure('invalid-input', 'PR 列表筛选参数不合法') })
  const o = typeof value === 'string' ? { state: value } : value
  if (!record(o)) return fail()
  if (o.state !== undefined && !isGhPrListState(o.state) || o.author !== undefined && o.author !== '@me' && !username(o.author) || !names(o.labels, label) || o.draft !== undefined && typeof o.draft !== 'boolean' || o.review !== undefined && (typeof o.review !== 'string' || !['none', 'required', 'approved', 'changes_requested'].includes(o.review)) || o.sort !== undefined && (typeof o.sort !== 'string' || !['created', 'updated', 'comments'].includes(o.sort)) || o.direction !== undefined && (typeof o.direction !== 'string' || !['asc', 'desc'].includes(o.direction))) return fail()
  const limit = o.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) return fail()
  const args = ['pr', 'list', '--state', String(o.state ?? 'open'), '--limit', String(limit + 1)]
  if (o.author) args.push('--author', String(o.author))
  for (const name of (o.labels ?? []) as string[]) args.push('--label', name)
  if (o.draft !== undefined) args.push(`--draft=${o.draft}`)
  const search = []
  if (o.review) search.push(`review:${o.review}`)
  if (o.sort || o.direction) search.push(`sort:${o.sort ?? 'updated'}-${o.direction ?? 'desc'}`)
  if (search.length) args.push('--search', search.join(' '))
  return { ok: true, args, limit }
}
