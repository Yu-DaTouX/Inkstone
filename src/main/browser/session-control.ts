import { INTERACTIVE_RESOURCE, sharedResources, type ResourceCoordinator } from '../interactive-resources'

export function browserResource(sessionId: string): string {
  return `browser-session:${sessionId}`
}

export interface UserHandoff {
  reason: string
  sessionId: string
  at: number
  external: boolean
}

export class BrowserSessionControl {
  private readonly handoffs = new Map<string, UserHandoff>()
  private readonly owners = new Map<string, string>()
  private readonly downloadStarts = new Map<string, { name: string; at: number }>()
  private readonly agentSessions = new Set<string>()
  private paused = new Set<string>()

  constructor(private readonly resources: Pick<ResourceCoordinator, 'setPaused'> = sharedResources) {}

  private externalHandoff(): UserHandoff | undefined {
    for (const handoff of this.handoffs.values()) if (handoff.external) return handoff
    return undefined
  }

  handoff(sessionId: string): UserHandoff | undefined {
    return this.handoffs.get(sessionId) ?? this.externalHandoff()
  }

  controlled(sessionId: string): boolean {
    return Boolean(this.handoff(sessionId))
  }

  request(key: string, request: { reason?: string; sessionId?: string; external?: boolean }): void {
    this.handoffs.set(key, { reason: request.reason ?? '', sessionId: request.sessionId ?? '', at: Date.now(), external: request.external === true })
  }

  releaseFor(sessionId: string): boolean {
    let changed = this.handoffs.delete(sessionId)
    for (const [key, handoff] of this.handoffs) {
      if (handoff.external && (!handoff.sessionId || handoff.sessionId === sessionId)) {
        this.handoffs.delete(key)
        changed = true
      }
    }
    return changed
  }

  releaseVisible(key: string): void {
    this.handoffs.delete(key)
    for (const [other, handoff] of this.handoffs) if (handoff.external) this.handoffs.delete(other)
  }

  releaseExternal(): void {
    for (const [key, handoff] of this.handoffs) if (handoff.external) this.handoffs.delete(key)
  }

  setOwner(sessionId: string, owner?: string): void {
    if (owner) this.owners.set(sessionId, owner)
    else this.owners.delete(sessionId)
  }

  owner(sessionId: string): string | undefined {
    return this.owners.get(sessionId)
  }

  noteDownload(sessionId: string, name: string, at = Date.now()): void {
    this.downloadStarts.set(sessionId, { name, at })
  }

  downloadSince(sessionId: string, since: number): string | undefined {
    const started = this.downloadStarts.get(sessionId)
    return started && started.at >= since ? started.name : undefined
  }

  markAgent(sessionId: string): boolean {
    if (this.agentSessions.has(sessionId)) return false
    this.agentSessions.add(sessionId)
    return true
  }

  clearAgent(sessionId: string): void {
    this.agentSessions.delete(sessionId)
  }

  isAgent(sessionId: string): boolean {
    return this.agentSessions.has(sessionId)
  }

  forget(sessionId: string): void {
    this.handoffs.delete(sessionId)
    this.owners.delete(sessionId)
    this.downloadStarts.delete(sessionId)
    this.agentSessions.delete(sessionId)
  }

  clear(): void {
    this.handoffs.clear()
    this.owners.clear()
    this.downloadStarts.clear()
    this.agentSessions.clear()
  }

  syncPaused(): void {
    const next = new Set<string>()
    for (const key of this.handoffs.keys()) next.add(browserResource(key))
    if (this.handoffs.size) next.add(INTERACTIVE_RESOURCE)
    for (const id of this.paused) if (!next.has(id)) this.resources.setPaused(id, false)
    for (const id of next) this.resources.setPaused(id, true)
    this.paused = next
  }
}
