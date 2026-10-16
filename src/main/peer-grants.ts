import { randomUUID } from 'node:crypto'
import {
  PEER_ACTIVATION_TIMEOUT_MS,
  PEER_APPROVAL_TIMEOUT_MS,
  PEER_OPERATIONS,
  type PeerApprovalDecision,
  type PeerApprovalRequest,
  type PeerGrantView,
  type PeerOperation,
  type PeerProjectRef
} from '../shared/peer-protocol'
import type { RemoteDeviceSummary } from '../shared/remote-protocol'

interface Pending {
  request: PeerApprovalRequest
  resolve: (decision: PeerApprovalDecision | null) => void
  timer: NodeJS.Timeout
}

export type PeerCheck =
  | { ok: true; grant: PeerGrantView }
  | { ok: false; status: number; code: string; error: string }

export class PeerGrantRegistry {
  private readonly pending = new Map<string, Pending>()
  private readonly grants = new Map<string, PeerGrantView>()
  private readonly activationTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly hooks: {
      ask: (request: PeerApprovalRequest) => void
      closed: (requestId: string) => void
      changed: (grants: PeerGrantView[], revoked?: string) => void
      now?: () => number
    }
  ) {}

  private now(): number {
    return this.hooks.now?.() ?? Date.now()
  }

  list(): PeerGrantView[] {
    return [...this.grants.values()]
  }

  pendingRequests(): PeerApprovalRequest[] {
    return [...this.pending.values()].map((item) => item.request)
  }

  async request(device: RemoteDeviceSummary, operations: PeerOperation[], note: string, projects: PeerProjectRef[]): Promise<PeerGrantView | null> {
    for (const [id, item] of this.pending) {
      if (item.request.deviceId === device.id) this.finish(id, null)
    }
    const requested = PEER_OPERATIONS.filter((op) => operations.includes(op))
    const request: PeerApprovalRequest = {
      requestId: randomUUID(),
      deviceId: device.id,
      deviceName: device.name,
      operations: requested.length ? requested : ['read'],
      note: note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200),
      projects,
      expiresAt: this.now() + PEER_APPROVAL_TIMEOUT_MS
    }
    const decision = await new Promise<PeerApprovalDecision | null>((resolve) => {
      const timer = setTimeout(() => this.finish(request.requestId, null), PEER_APPROVAL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(request.requestId, { request, resolve, timer })
      this.hooks.ask(request)
    })
    if (!decision?.approve) return null
    const chosenProjects = projects.filter((project) => decision.projectIds.includes(project.id))
    const chosenOps = request.operations.filter((op) => decision.operations.includes(op))
    if (!chosenProjects.length || !chosenOps.length) return null
    const grant: PeerGrantView = {
      connectionId: `conn-${randomUUID()}`,
      deviceId: device.id,
      deviceName: device.name,
      projects: chosenProjects,
      operations: chosenOps,
      grantedAt: this.now(),
      activatedAt: null
    }
    this.grants.set(grant.connectionId, grant)
    const timer = setTimeout(() => {
      if (this.grants.get(grant.connectionId)?.activatedAt === null) this.revoke(grant.connectionId)
    }, PEER_ACTIVATION_TIMEOUT_MS)
    timer.unref?.()
    this.activationTimers.set(grant.connectionId, timer)
    this.hooks.changed(this.list())
    return grant
  }

  decide(decision: PeerApprovalDecision): boolean {
    if (!this.pending.has(decision.requestId)) return false
    this.finish(decision.requestId, decision)
    return true
  }

  private finish(requestId: string, decision: PeerApprovalDecision | null): void {
    const item = this.pending.get(requestId)
    if (!item) return
    clearTimeout(item.timer)
    this.pending.delete(requestId)
    item.resolve(decision)
    this.hooks.closed(requestId)
  }

  activate(connectionId: string, deviceId: string): PeerGrantView | null {
    const grant = this.grants.get(connectionId)
    if (!grant || grant.deviceId !== deviceId || grant.activatedAt !== null) return null
    grant.activatedAt = this.now()
    clearTimeout(this.activationTimers.get(connectionId))
    this.activationTimers.delete(connectionId)
    this.hooks.changed(this.list())
    return grant
  }

  revoke(connectionId: string): boolean {
    if (!this.grants.delete(connectionId)) return false
    clearTimeout(this.activationTimers.get(connectionId))
    this.activationTimers.delete(connectionId)
    this.hooks.changed(this.list(), connectionId)
    return true
  }

  revokeDevice(deviceId: string): void {
    for (const grant of this.list()) if (grant.deviceId === deviceId) this.revoke(grant.connectionId)
    for (const [id, item] of this.pending) if (item.request.deviceId === deviceId) this.finish(id, null)
  }

  revokeAll(): void {
    for (const grant of this.list()) this.revoke(grant.connectionId)
    for (const id of [...this.pending.keys()]) this.finish(id, null)
  }

  check(connectionId: string | undefined, deviceId: string, operation: PeerOperation, projectId?: string): PeerCheck {
    const grant = connectionId ? this.grants.get(connectionId) : undefined
    if (!grant || grant.deviceId !== deviceId) {
      return { ok: false, status: 401, code: 'peer_connection_required', error: '本次连接未获批准或已失效，请重新申请连接' }
    }
    if (grant.activatedAt === null) {
      return { ok: false, status: 409, code: 'peer_connection_inactive', error: '连接尚未建立事件流' }
    }
    if (!grant.operations.includes(operation)) {
      return { ok: false, status: 403, code: 'peer_operation_denied', error: '这个操作不在本次连接的授权范围内，需要重新申请' }
    }
    if (projectId !== undefined && !grant.projects.some((project) => project.id === projectId)) {
      return { ok: false, status: 403, code: 'peer_project_denied', error: '这个项目没有向本次连接开放' }
    }
    return { ok: true, grant }
  }
}
