import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

/** 受管入口共享的 FIFO；超时只取消尚未开始的请求，绝不释放正在执行的动作。 */
export class ResourceCoordinator {
  private readonly resources = new Map<string, Resource>()
  private journal?: string

  /** 在发送交互动作前落盘；重启时未释放的操作必须先核对，不能重放。 */
  attachJournal(file: string): void {
    if (this.journal === file) return
    if (this.journal) throw new Error('交互资源已绑定另一个宿主数据目录')
    this.journal = file
    if (existsSync(file)) {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (!Array.isArray(saved) || saved.length > 64) throw new Error('资源记录无效')
        for (const entry of saved) {
          if (!entry || typeof entry.resourceId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(entry.resourceId) || !Number.isSafeInteger(entry.epoch) || entry.epoch < 0 || typeof entry.uncertain !== 'boolean' || typeof entry.paused !== 'boolean' || !(entry.owner === null || typeof entry.owner === 'string') || !(entry.operationId === null || typeof entry.operationId === 'string')) throw new Error('资源记录无效')
        }
        for (const entry of saved) this.resources.set(entry.resourceId, {
          owner: entry.owner, operationId: entry.operationId, epoch: entry.epoch + 1,
          uncertain: entry.uncertain || entry.owner !== null || entry.operationId !== null,
          paused: entry.paused, queue: []
        })
      } catch {
        copyFileSync(file, `${file}.invalid-${Date.now()}-${randomUUID()}`)
        this.resources.set('windows-interaction', { owner: null, operationId: null, epoch: 1, uncertain: true, paused: false, queue: [] })
      }
    }
    this.checkpoint()
  }

  private checkpoint(): void {
    if (!this.journal) return
    try {
      mkdirSync(dirname(this.journal), { recursive: true })
      const tmp = `${this.journal}.tmp`
      const fd = openSync(tmp, 'w')
      try { writeFileSync(fd, JSON.stringify(this.snapshot())); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, this.journal)
    } catch (error) {
      for (const r of this.resources.values()) {
        r.uncertain = true
        for (const pending of r.queue.splice(0)) { clearTimeout(pending.timer); pending.reject(new Error('资源记录写入失败，交互已暂停，请在电脑核对')) }
      }
      throw new Error('资源记录写入失败，交互已暂停，请在电脑核对', { cause: error })
    }
  }

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
    this.checkpoint()
    let released = false
    return () => {
      if (released || r.epoch !== epoch) return
      released = true
      if (r.uncertain) return
      r.owner = null
      r.operationId = null
      this.checkpoint()
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
    this.checkpoint()
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
    this.checkpoint()
  }

  /** 只能在宿主确认旧动作已停止并核对结果后恢复。 */
  resolveUncertain(resourceId: string): void {
    const r = this.resources.get(resourceId)
    if (!r?.uncertain) return
    r.uncertain = false
    r.owner = null
    r.operationId = null
    r.epoch++
    this.checkpoint()
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
/** CDP 与 Windows 输入可能作用于同一浏览器，过渡期使用同一交互资源。 */
export const INTERACTIVE_RESOURCE = 'windows-interaction'
