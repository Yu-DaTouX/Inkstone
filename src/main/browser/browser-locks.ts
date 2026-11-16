import { INTERACTIVE_RESOURCE, ResourceBusyError, sharedResources, type ResourceCoordinator } from '../interactive-resources'
import { browserResource } from './session-control'
import { pick } from '../../shared/ui-lang'

export interface BrowserLockRequest {
  sessionId: string
  owner: string
  external: () => boolean
  connecting?: boolean
  confirming?: boolean
}

export class BrowserLocks {
  private embeddedInFlight = 0
  private externalGate = 0
  private readonly drained: Array<() => void> = []
  private readonly uncertain = new Set<string>()

  constructor(
    private readonly resources: Pick<ResourceCoordinator, 'acquire' | 'markUncertain' | 'resolveUncertain'> = sharedResources,
    private readonly drainMs = 1500
  ) {}

  markUncertain(resourceId: string): void {
    this.uncertain.add(resourceId)
    this.resources.markUncertain(resourceId)
  }

  clearExternalUncertain(): void {
    if (this.uncertain.delete(INTERACTIVE_RESOURCE)) this.resources.resolveUncertain(INTERACTIVE_RESOURCE)
  }

  async gate<T>(fn: () => Promise<T>): Promise<T> {
    this.externalGate++
    try {
      await this.drain()
      return await fn()
    } finally {
      this.externalGate--
    }
  }

  private confirm(resourceId: string, confirming: boolean | undefined): void {
    if (confirming && this.uncertain.delete(resourceId)) this.resources.resolveUncertain(resourceId)
  }

  private global(): boolean {
    return this.externalGate > 0
  }

  private async exclusive<T>(request: BrowserLockRequest, fn: (resourceId: string) => Promise<T>): Promise<T> {
    this.confirm(INTERACTIVE_RESOURCE, request.confirming)
    const release = await this.resources.acquire(INTERACTIVE_RESOURCE, request.owner)
    try { return await fn(INTERACTIVE_RESOURCE) } finally { release() }
  }

  private async drain(): Promise<void> {
    if (this.embeddedInFlight === 0) return
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        const index = this.drained.indexOf(done)
        if (index >= 0) this.drained.splice(index, 1)
        reject(new ResourceBusyError(INTERACTIVE_RESOURCE, pick('其他会话的内置浏览器操作', 'built-in browser work in another session')))
      }, this.drainMs)
      this.drained.push(done)
    })
  }

  async run<T>(request: BrowserLockRequest, fn: (resourceId: string) => Promise<T>): Promise<T> {
    if (request.connecting) {
      return this.exclusive(request, (resourceId) => this.gate(() => fn(resourceId)))
    }
    if (this.global() || request.external()) return this.exclusive(request, fn)
    const resourceId = browserResource(request.sessionId)
    this.confirm(resourceId, request.confirming)
    const release = await this.resources.acquire(resourceId, request.owner)
    let switched: boolean
    try {
      switched = this.global() || request.external()
    } catch (error) {
      release()
      throw error
    }
    if (switched) {
      release()
      return this.exclusive(request, fn)
    }
    this.embeddedInFlight++
    try {
      return await fn(resourceId)
    } finally {
      release()
      this.embeddedInFlight--
      if (this.embeddedInFlight === 0) for (const wake of this.drained.splice(0)) wake()
    }
  }
}

export const browserLocks = new BrowserLocks()
