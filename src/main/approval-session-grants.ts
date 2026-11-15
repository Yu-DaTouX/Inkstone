import { createHash } from 'node:crypto'
import { approvalBindsCommand, approvalSessionGrantable, OUTSIDE_WRITE_REASON, type ApprovalOwner, type ApprovalRequest } from '../shared/approval'
import { sameOwner } from './approval-ledger'

interface ScopeGrants {
  owner?: ApprovalOwner
  sessions: Map<string, Set<string>>
}

type GrantFields = Pick<ApprovalRequest, 'kind' | 'tool' | 'rememberDirs'> & Partial<Pick<ApprovalRequest, 'reasons' | 'danger' | 'title' | 'sessionId' | 'detail' | 'cwd'>>

function commandIdentity(request: GrantFields): string {
  if (!approvalBindsCommand(request)) return ''
  return createHash('sha256').update(`${(request.detail ?? '').trim()}\u0000${(request.cwd ?? '').trim()}`).digest('hex')
}

function operationClass(request: GrantFields): string {
  if (request.kind === 'consent') return `${request.title ?? ''}\u0000${request.danger ?? ''}`
  if (request.kind === 'danger' || request.kind === 'delete' || request.kind === 'outside') {
    const reasons = (request.reasons ?? []).filter((reason) => request.kind !== 'outside' || !reason.startsWith(OUTSIDE_WRITE_REASON))
    return `${request.title ?? ''}\u0000${[...reasons].sort().join('\n')}\u0000${request.danger ?? ''}\u0000${commandIdentity(request)}`
  }
  return ''
}

export function sessionGrantKey(request: GrantFields): string | null {
  if (!approvalSessionGrantable(request)) return null
  const dirs = [...(request.rememberDirs ?? [])].sort().join('\n')
  return `${request.kind}\u0000${request.tool}\u0000${dirs}\u0000${operationClass(request)}`
}

function sessionSlot(request: Pick<GrantFields, 'sessionId'>): string {
  return request.sessionId ?? ''
}

export class ApprovalSessionGrants {
  private readonly scopes = new Map<string, ScopeGrants>()

  grant(scope: string | undefined, request: ApprovalRequest): boolean {
    const key = sessionGrantKey(request)
    if (!scope || !key) return false
    const existing = this.scopes.get(scope)
    if (existing && !sameOwner(existing.owner, request.owner)) this.scopes.delete(scope)
    const entry = this.scopes.get(scope) ?? { ...(request.owner ? { owner: request.owner } : {}), sessions: new Map<string, Set<string>>() }
    const slot = sessionSlot(request)
    const keys = entry.sessions.get(slot) ?? new Set<string>()
    keys.add(key)
    entry.sessions.set(slot, keys)
    this.scopes.set(scope, entry)
    return true
  }

  allows(scope: string | undefined, request: GrantFields & Pick<ApprovalRequest, 'owner'>): boolean {
    const key = sessionGrantKey(request)
    const entry = scope ? this.scopes.get(scope) : undefined
    if (!entry || !key) return false
    if (!sameOwner(entry.owner, request.owner)) return false
    return entry.sessions.get(sessionSlot(request))?.has(key) === true
  }

  clear(scope: string, owner?: ApprovalOwner): void {
    const entry = this.scopes.get(scope)
    if (entry && owner && entry.owner && !sameOwner(entry.owner, owner)) return
    this.scopes.delete(scope)
  }

  clearOtherOwners(scope: string, owner: ApprovalOwner): void {
    const entry = this.scopes.get(scope)
    if (entry && !sameOwner(entry.owner, owner)) this.scopes.delete(scope)
  }
}
