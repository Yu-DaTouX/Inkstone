import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TaskInfo, TaskKind, TaskProgress } from '../shared/api.ts'

const KEEP_FINISHED = 20

export interface TaskHandle {
  readonly id: string
  readonly signal: AbortSignal
  progress(progress: TaskProgress, detail?: string): void
  succeed(detail?: string): void
  fail(error: unknown): void
}

export class TaskCenter extends EventEmitter {
  private readonly tasks = new Map<string, TaskInfo>()
  private readonly controllers = new Map<string, AbortController>()

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => ({ ...task }))
  }

  private put(task: TaskInfo): void {
    this.tasks.set(task.id, task)
    if (task.state !== 'running' && task.state !== 'queued') this.controllers.delete(task.id)
    this.prune()
    this.emit('task', { ...task })
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((task) => task.state !== 'running' && task.state !== 'queued')
    for (const task of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.tasks.delete(task.id)
  }

  private patch(id: string, patch: Partial<TaskInfo>): void {
    const task = this.tasks.get(id)
    if (!task || (task.state !== 'running' && task.state !== 'queued')) return
    this.put({ ...task, ...patch })
  }

  busyFor(target: string): TaskInfo | undefined {
    return [...this.tasks.values()].find((task) => task.target === target && (task.state === 'running' || task.state === 'queued'))
  }

  start(kind: TaskKind, title: string, target: string | null = null): TaskHandle {
    if (target && this.busyFor(target)) throw new Error('这个版本正在执行其他任务，等它结束再试')
    const id = randomUUID()
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.put({ id, kind, title, target, state: 'running', progress: null, detail: null, error: null, startedAt: Date.now(), endedAt: null })
    return {
      id,
      signal: controller.signal,
      progress: (progress, detail) => this.patch(id, { progress, ...(detail !== undefined ? { detail } : {}) }),
      succeed: (detail) => this.patch(id, { state: 'done', endedAt: Date.now(), ...(detail !== undefined ? { detail } : {}) }),
      fail: (error) => {
        const aborted = controller.signal.aborted
        this.patch(id, { state: aborted ? 'cancelled' : 'failed', endedAt: Date.now(), error: aborted ? null : error instanceof Error ? error.message : String(error) })
      }
    }
  }

  cancel(id: string): void {
    const controller = this.controllers.get(id)
    if (!controller) return
    controller.abort()
    this.patch(id, { state: 'cancelled', endedAt: Date.now() })
  }

  detail(id: string, detail: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.put({ ...task, detail })
  }

  clearFinished(): void {
    for (const task of [...this.tasks.values()]) {
      if (task.state !== 'running' && task.state !== 'queued') this.tasks.delete(task.id)
    }
    this.emit('cleared')
  }
}
