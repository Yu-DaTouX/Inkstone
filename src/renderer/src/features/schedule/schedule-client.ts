/**
 * 定时任务 IPC 的薄转发（v3 定时页专用）。
 *
 * 只转发 preload 暴露的 `window.yan.schedule` 既有方法，不缓存结果、不改写返回、
 * 不重排任务、不新增状态：列表由主进程服务给出，运行过程留在触发出来的会话里。
 * 显式接受 `bridge` 参数，纯本地测试用假实现即可核对调用的方法名与参数。
 */
import type { ScheduledTask, ScheduleTrigger } from '../../../../shared/schedule'

export interface ScheduleInput {
  name?: string
  prompt: string
  cwd?: string
  model?: string
  trigger: ScheduleTrigger
}

export type ScheduleMutation = { ok: boolean; error?: string; task?: ScheduledTask }
export type ScheduleRemove = { ok: boolean; error?: string }
export type ScheduleRun = { ok: boolean; error?: string; sessionId?: string }

/** 与 `shared/ipc.ts` 的 `ScheduleBridge` 同形。 */
export interface ScheduleBridge {
  list(): Promise<ScheduledTask[]>
  create(input: ScheduleInput): Promise<ScheduleMutation>
  update(id: string, input: Partial<ScheduleInput>): Promise<ScheduleMutation>
  setEnabled(id: string, enabled: boolean): Promise<ScheduleMutation>
  remove(id: string): Promise<ScheduleRemove>
  runNow(id: string): Promise<ScheduleRun>
}

/** 生产客户端：preload 已注册的桥。 */
export function createScheduleClient(): ScheduleBridge {
  return window.yan.schedule
}

export function loadTasks(bridge: ScheduleBridge): Promise<ScheduledTask[]> {
  return bridge.list()
}

/** 有 id 走 update，没有走 create；输入已由 `checkDraft` 规整。 */
export function saveTask(bridge: ScheduleBridge, id: string | undefined, input: ScheduleInput): Promise<ScheduleMutation> {
  return id ? bridge.update(id, input) : bridge.create(input)
}

export function setTaskEnabled(bridge: ScheduleBridge, id: string, enabled: boolean): Promise<ScheduleMutation> {
  return bridge.setEnabled(id, enabled)
}

export function removeTask(bridge: ScheduleBridge, id: string): Promise<ScheduleRemove> {
  return bridge.remove(id)
}

export function runTaskNow(bridge: ScheduleBridge, id: string): Promise<ScheduleRun> {
  return bridge.runNow(id)
}
