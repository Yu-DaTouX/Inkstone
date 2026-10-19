import type { ApprovalOwner, ApprovalRequest } from '../shared/approval'
import { sameOwner } from './approval-ledger'

interface ScopeGrants {
  owner?: ApprovalOwner
  keys: Set<string>
}

export function sessionGrantKey(request: Pick<ApprovalRequest, 'kind' | 'tool' | 'rememberDirs'>): string | null {
  if (request.kind === 'move') return null
  const dirs = [...(request.rememberDirs ?? [])].sort().join('\n')
  return `${request.kind}\u0000${request.tool}\u0000${dirs}`
}

export class ApprovalSessionGrants {
  private readonly scopes = new Map<string, ScopeGrants>()

  grant(scope: string | undefined, request: ApprovalRequest): boolean {
    const key = sessionGrantKey(request)
    if (!scope || !key) return false
    const existing = this.scopes.get(scope)
    if (existing && !sameOwner(existing.owner, request.owner)) this.scopes.delete(scope)
    const entry = this.scopes.get(scope) ?? { ...(request.owner ? { owner: request.owner } : {}), keys: new Set<string>() }
    entry.keys.add(key)
    this.scopes.set(scope, entry)
    return true
  }

  allows(scope: string | undefined, request: Pick<ApprovalRequest, 'kind' | 'tool' | 'rememberDirs' | 'owner'>): boolean {
    const key = sessionGrantKey(request)
    const entry = scope ? this.scopes.get(scope) : undefined
    if (!entry || !key) return false
    if (!sameOwner(entry.owner, request.owner)) return false
    return entry.keys.has(key)
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
