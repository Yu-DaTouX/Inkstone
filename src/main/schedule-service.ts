/**
 * 定时任务：到点新开一条会话，用任务里的指令（和模型）跑一遍。
 *
 * 只在砚运行时触发；砚没开着错过的任务，下次启动时（24 小时内）补跑一次，更早的直接跳到下一次。
 * 触发出来的会话和普通会话一样留在会话列表里，调度器不保存运行过程，只记上次触发与错误。
 * 数据是 `YAN_DIR/schedules.json`，一个文件，写入用临时文件替换。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_PROMPT_LENGTH,
  nextRunAt,
  normalizeTrigger,
  type ScheduledTask,
  type ScheduleTrigger
} from '../shared/schedule'

const TICK_MS = 30_000
/** 错过多久以内的任务在启动时补跑 */
const CATCH_UP_MS = 24 * 60 * 60_000

export interface ScheduleInput {
  name?: unknown
  prompt?: unknown
  cwd?: unknown
  model?: unknown
  trigger?: unknown
}

export interface ScheduleServiceOptions {
  file: string
  /** 触发：新开会话并发出指令；失败抛错，错误文字记进任务 */
  run(task: ScheduledTask): Promise<{ sessionId?: string }>
  onChanged?(tasks: ScheduledTask[]): void
  now?(): number
}

export class ScheduleService {
  private tasks: ScheduledTask[] = []
  private timer: NodeJS.Timeout | null = null
  private running = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private loaded = false
  private loading?: Promise<void>
  private readonly now: () => number

  constructor(private readonly opts: ScheduleServiceOptions) {
    this.now = opts.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.mutate<void>((tasks) => {
      const now = this.now()
      let changed = false
      for (const task of tasks) {
        if (!task.enabled || task.nextRunAt === undefined || task.nextRunAt > now - 60_000) continue
        if (now - task.nextRunAt <= CATCH_UP_MS) task.nextRunAt = now
        else this.advance(task, now)
        changed = true
      }
      return { result: undefined, changed }
    })
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): ScheduledTask[] {
    return structuredClone(this.tasks)
  }

  /** 创建任务。模型创建的先停着等用户确认；用户创建的直接启用。 */
  async create(input: ScheduleInput, by: 'user' | 'model'): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
    const checked = this.check(input)
    if (!checked.ok) return checked
    return this.mutate<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>((tasks) => {
      const now = this.now()
      const task: ScheduledTask = {
        id: randomUUID().slice(0, 8),
        ...checked.value,
        createdBy: by,
        createdAt: now,
        enabled: by === 'user',
        ...(by === 'model' ? { pendingApproval: true } : {})
      }
      if (task.enabled) task.nextRunAt = nextRunAt(task.trigger, now)
      if (task.enabled && task.nextRunAt === undefined) return { result: { ok: false, error: '这个时间已经过去了' } }
      tasks.push(task)
      return { result: { ok: true, task: structuredClone(task) }, changed: true }
    })
  }

  async update(id: string, input: ScheduleInput): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
    return this.mutate<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>((tasks) => {
      const task = tasks.find(item => item.id === id)
      if (!task) return { result: { ok: false, error: '找不到这个定时任务' } }
      const checked = this.check({ name: task.name, prompt: task.prompt, cwd: task.cwd, model: task.model, trigger: task.trigger, ...input })
      if (!checked.ok) return { result: checked }
      Object.assign(task, checked.value)
      if (!checked.value.cwd) delete task.cwd
      if (!checked.value.model) delete task.model
      if (task.enabled) this.advance(task, this.now(), true)
      return { result: { ok: true, task: structuredClone(task) }, changed: true }
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
    return this.mutate<{ ok: true; task: ScheduledTask } | { ok: false; error: string }>((tasks) => {
      const task = tasks.find(item => item.id === id)
      if (!task) return { result: { ok: false, error: '找不到这个定时任务' } }
      task.enabled = enabled
      if (enabled) {
        this.advance(task, this.now(), true)
        if (task.nextRunAt === undefined) return { result: { ok: false, error: '这个时间已经过去了，请先改时间' } }
        delete task.pendingApproval
      } else delete task.nextRunAt
      return { result: { ok: true, task: structuredClone(task) }, changed: true }
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex(task => task.id === id)
      if (index < 0) return { result: false }
      tasks.splice(index, 1)
      return { result: true, changed: true }
    })
  }

  /** 立即触发一次（不改变原有的下次时间） */
  async runNow(id: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    await this.chain
    await this.load()
    const task = this.tasks.find(item => item.id === id)
    if (!task) return { ok: false, error: '找不到这个定时任务' }
    return this.fire(task, false)
  }

  private check(input: ScheduleInput): { ok: true; value: Pick<ScheduledTask, 'name' | 'prompt' | 'trigger'> & { cwd?: string; model?: string } } | { ok: false; error: string } {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return { ok: false, error: '缺少指令（prompt）' }
    if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, error: `指令不能超过 ${MAX_PROMPT_LENGTH} 个字符` }
    const name = (typeof input.name === 'string' ? input.name.trim() : '').slice(0, 80) || prompt.split('\n')[0].slice(0, 40)
    const trigger = normalizeTrigger(input.trigger)
    if (!trigger.ok) return trigger
    const cwd = typeof input.cwd === 'string' ? input.cwd.trim().slice(0, 1000) : ''
    const model = typeof input.model === 'string' && input.model.includes('/') ? input.model.trim().slice(0, 200) : ''
    return { ok: true, value: { name, prompt, trigger: trigger.trigger, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) } }
  }

  /** 触发后（或启用 / 改时间后）算下一次；单次任务跑完就停用 */
  private advance(task: ScheduledTask, from: number, fresh = false): void {
    const next = nextRunAt(task.trigger, from)
    if (next === undefined) {
      delete task.nextRunAt
      if (!fresh) task.enabled = false
      return
    }
    task.nextRunAt = next
  }

  private async tick(): Promise<void> {
    const now = this.now()
    for (const task of this.tasks) {
      if (task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now && !this.running.has(task.id)) {
        void this.fire(task, true).catch((error) => {
          // 未能保存执行结果时停止调度，避免每次 tick 重复执行同一项。
          this.stop()
          console.error('[schedule] 保存运行结果失败，调度已暂停', error)
        })
      }
    }
  }

  private async fire(task: ScheduledTask, scheduled: boolean): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    if (this.running.has(task.id)) return { ok: false, error: '这个任务正在触发中' }
    this.running.add(task.id)
    const snapshot = structuredClone(task)
    const startedAt = this.now()
    let result: { ok: boolean; error?: string; sessionId?: string }
    try {
      try {
        const run = await this.opts.run(snapshot)
        result = { ok: true, sessionId: run.sessionId }
      } catch (error) {
        result = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
      }
      await this.mutate<void>((tasks) => {
        const latest = tasks.find(item => item.id === task.id)
        if (!latest) return { result: undefined }
        latest.lastRunAt = startedAt
        if (result.ok) {
          latest.lastSessionId = result.sessionId ?? latest.lastSessionId
          delete latest.lastError
        } else latest.lastError = result.error
        // 运行期间的暂停、删除和重新排期不被旧快照覆盖。
        if (scheduled && latest.enabled && latest.nextRunAt === snapshot.nextRunAt && JSON.stringify(latest.trigger) === JSON.stringify(snapshot.trigger)) {
          this.advance(latest, startedAt)
        }
        return { result: undefined, changed: true }
      })
      return result
    } finally {
      this.running.delete(task.id)
    }
  }

  /** 在串行链内复制、保存，再发布；写失败不改变内存或推送成功状态。 */
  private mutate<T>(change: (tasks: ScheduledTask[]) => { result: T; changed?: boolean }): Promise<T> {
    const operation = this.chain.then(async () => {
      await this.load()
      const tasks = structuredClone(this.tasks)
      const outcome = change(tasks)
      if (outcome.changed) {
        await this.save(tasks)
        this.tasks = tasks
        this.opts.onChanged?.(this.list())
      }
      return outcome.result
    })
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loading) return this.loading
    this.loading = this.readTasks().then((tasks) => {
      this.tasks = tasks
      this.loaded = true
    }).finally(() => { this.loading = undefined })
    return this.loading
  }

  private async readTasks(): Promise<ScheduledTask[]> {
    let text: string
    try {
      text = await readFile(this.opts.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed = JSON.parse(text) as { v?: number; tasks?: ScheduledTask[] }
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.tasks)) throw new Error('定时任务文件格式无效，已保留原文件')
    const ids = new Set<string>()
    for (const task of parsed.tasks) {
      if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id) ||
          typeof task.prompt !== 'string' || typeof task.enabled !== 'boolean' ||
          !Number.isFinite(task.createdAt) || !['user', 'model'].includes(task.createdBy) ||
          !normalizeTrigger(task.trigger).ok ||
          (task.nextRunAt !== undefined && !Number.isFinite(task.nextRunAt))) {
        throw new Error('定时任务条目无效，已保留原文件')
      }
      ids.add(task.id)
    }
    return parsed.tasks
  }

  private async save(tasks: ScheduledTask[]): Promise<void> {
    await mkdir(dirname(this.opts.file), { recursive: true })
    const temp = `${this.opts.file}.tmp`
    await writeFile(temp, JSON.stringify({ v: 1, tasks }, null, 2), 'utf8')
    await rename(temp, this.opts.file)
  }
}

export type { ScheduledTask, ScheduleTrigger }
