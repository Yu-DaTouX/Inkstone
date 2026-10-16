import { randomUUID } from 'node:crypto'

export class ResourceBusyError extends Error {
  readonly code = 'waiting_resource'
  constructor(readonly resourceId: string, readonly owner: string) {
    super(`等待资源 ${resourceId}，当前由 ${owner} 使用；本次操作尚未开始。`)
  }
}

interface Pending {
  owner: string
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Resource {
  owner: string | null
  operationId: string | null
  epoch: number
  uncertain: boolean
  paused: boolean
  queue: Pending[]
}

export class ResourceCoordinator {
  private readonly resources = new Map<string, Resource>()

  snapshot() {
    return [...this.resources].map(([resourceId, r]) => ({
      resourceId, owner: r.owner, operationId: r.operationId, epoch: r.epoch,
      uncertain: r.uncertain, paused: r.paused, waiting: r.queue.length
    }))
  }

  async acquire(resourceId: string, owner: string, waitMs = 1500): Promise<() => void> {
    let r = this.resources.get(resourceId)
    if (!r) {
      r = { owner: null, operationId: null, epoch: 0, uncertain: false, paused: false, queue: [] }
      this.resources.set(resourceId, r)
    }
    if (r.paused) throw new ResourceBusyError(resourceId, '用户接管')
    if (!r.owner && !r.uncertain) return this.grant(r, owner)
    if (r.queue.length >= 32 || r.uncertain) throw new ResourceBusyError(resourceId, r.owner ?? '结果待核实的操作')
    const resource = r
    return new Promise((resolve, reject) => {
      const pending: Pending = { owner, resolve, reject, timer: setTimeout(() => {
        const index = resource.queue.indexOf(pending)
        if (index >= 0) resource.queue.splice(index, 1)
        reject(new ResourceBusyError(resourceId, resource.owner ?? '其他操作'))
      }, waitMs) }
      resource.queue.push(pending)
    })
  }

  private grant(r: Resource, owner: string): () => void {
    r.owner = owner
    r.operationId = randomUUID()
    const epoch = ++r.epoch
    let released = false
    return () => {
      if (released || r.epoch !== epoch) return
      released = true
      if (r.uncertain) return
      r.owner = null
      r.operationId = null
      const next = r.paused ? undefined : r.queue.shift()
      if (next) {
        clearTimeout(next.timer)
        try { next.resolve(this.grant(r, next.owner)) } catch (error) { next.reject(error as Error) }
      }
    }
  }

  markUncertain(resourceId: string): void {
    let r = this.resources.get(resourceId)
    if (!r) {
      r = { owner: null, operationId: null, epoch: 0, uncertain: true, paused: false, queue: [] }
      this.resources.set(resourceId, r)
    }
    r.uncertain = true
    for (const pending of r.queue.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(new ResourceBusyError(resourceId, '结果待核实的操作'))
    }
  }

  setPaused(resourceId: string, paused: boolean): void {
    let r = this.resources.get(resourceId)
    if (r?.paused === paused) return
    if (!r) {
      r = { owner: null, operationId: null, epoch: 0, uncertain: false, paused, queue: [] }
      this.resources.set(resourceId, r)
    }
    r.paused = paused
    if (paused) {
      for (const pending of r.queue.splice(0)) {
        clearTimeout(pending.timer)
        pending.reject(new ResourceBusyError(resourceId, '用户接管'))
      }
    }
  }

  resolveUncertain(resourceId: string): void {
    const r = this.resources.get(resourceId)
    if (!r?.uncertain) return
    r.uncertain = false
    r.owner = null
    r.operationId = null
    r.epoch++
    const next = r.paused ? undefined : r.queue.shift()
    if (next) {
      clearTimeout(next.timer)
      try { next.resolve(this.grant(r, next.owner)) } catch (error) { next.reject(error as Error) }
    }
  }

  async run<T>(resourceId: string, owner: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(resourceId, owner)
    try { return await fn() } finally { release() }
  }
}

export const sharedResources = new ResourceCoordinator()
export const INTERACTIVE_RESOURCE = 'windows-interaction'
