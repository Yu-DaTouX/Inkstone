import type { ApprovalOwner, ApprovalPhase, ApprovalRequest, ApprovalSnapshot } from '../shared/approval'

export type ApprovalRejection = 'missing' | 'sending' | 'stale' | 'owner-mismatch' | 'revision-mismatch'

export type ApprovalBegin = { ok: true; request: ApprovalRequest } | { ok: false; reason: ApprovalRejection }

export interface ApprovalAnswerIdentity {
  owner?: ApprovalOwner
  revision?: number
}

interface LedgerEntry {
  request: ApprovalRequest
  scope?: string
  phase: ApprovalPhase
}

export function approvalIdentityFrom(value: unknown): ApprovalAnswerIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { owner?: { instanceId?: unknown; generation?: unknown }; revision?: unknown }
  const owner = raw.owner && typeof raw.owner.instanceId === 'string' && Number.isSafeInteger(raw.owner.generation)
    ? { instanceId: raw.owner.instanceId, generation: raw.owner.generation as number }
    : undefined
  const revision = Number.isSafeInteger(raw.revision) ? raw.revision as number : undefined
  if (!owner && revision === undefined) return undefined
  return { ...(owner ? { owner } : {}), ...(revision !== undefined ? { revision } : {}) }
}

export function sameOwner(a: ApprovalOwner | undefined, b: ApprovalOwner | undefined): boolean {
  if (!a || !b) return a === b
  return a.instanceId === b.instanceId && a.generation === b.generation
}

export class ApprovalLedger {
  private revision = 0
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly active = new Map<string, ApprovalOwner>()

  get currentRevision(): number {
    return this.revision
  }

  activate(scope: string, owner: ApprovalOwner): string[] {
    const previous = this.active.get(scope)
    this.active.set(scope, { ...owner })
    if (sameOwner(previous, owner)) return []
    return this.collect((entry) => entry.scope === scope && !!entry.request.owner && !sameOwner(entry.request.owner, owner))
  }

  retire(scope: string, owner?: ApprovalOwner): string[] {
    const current = this.active.get(scope)
    if (owner && current && !sameOwner(current, owner)) return []
    this.active.delete(scope)
    return this.collect((entry) => entry.scope === scope && (!owner || sameOwner(entry.request.owner, owner)))
  }

  isCurrent(scope: string | undefined, owner: ApprovalOwner | undefined): boolean {
    if (!scope || !owner) return true
    const current = this.active.get(scope)
    return !current || sameOwner(current, owner)
  }

  add(request: ApprovalRequest, scope?: string): ApprovalRequest | null {
    if (this.entries.has(request.id)) return null
    if (!this.isCurrent(scope, request.owner)) return null
    const stored: ApprovalRequest = { ...request, phase: 'pending', revision: this.bump() }
    this.entries.set(request.id, { request: stored, ...(scope ? { scope } : {}), phase: 'pending' })
    return stored
  }

  begin(id: string, identity?: ApprovalAnswerIdentity): ApprovalBegin {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: 'missing' }
    if (entry.phase !== 'pending') return { ok: false, reason: 'sending' }
    if (!this.isCurrent(entry.scope, entry.request.owner)) return { ok: false, reason: 'stale' }
    if (identity?.owner && !sameOwner(identity.owner, entry.request.owner)) return { ok: false, reason: 'owner-mismatch' }
    if (identity?.revision !== undefined && identity.revision !== entry.request.revision) return { ok: false, reason: 'revision-mismatch' }
    entry.phase = 'sending'
    entry.request = { ...entry.request, phase: 'sending', revision: this.bump() }
    return { ok: true, request: entry.request }
  }

  finish(id: string): ApprovalRequest | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.entries.delete(id)
    this.bump()
    return { ...entry.request, phase: 'resolved' }
  }

  expire(match: (request: ApprovalRequest) => boolean): string[] {
    return this.collect((entry) => entry.phase === 'pending' && match(entry.request))
  }

  stale(): string[] {
    return this.collect((entry) => entry.phase === 'pending' && !this.isCurrent(entry.scope, entry.request.owner))
  }

  get(id: string): ApprovalRequest | undefined {
    return this.entries.get(id)?.request
  }

  pending(): ApprovalRequest[] {
    return [...this.entries.values()].filter((entry) => entry.phase === 'pending').map((entry) => entry.request)
  }

  snapshot(): ApprovalSnapshot {
    return { revision: this.revision, items: [...this.entries.values()].map((entry) => entry.request) }
  }

  private collect(match: (entry: LedgerEntry) => boolean): string[] {
    return [...this.entries.entries()].filter(([, entry]) => match(entry)).map(([id]) => id)
  }

  private bump(): number {
    this.revision += 1
    return this.revision
  }
}
