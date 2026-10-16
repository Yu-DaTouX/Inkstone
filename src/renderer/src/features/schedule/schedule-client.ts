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

export interface ScheduleBridge {
  list(): Promise<ScheduledTask[]>
  create(input: ScheduleInput): Promise<ScheduleMutation>
  update(id: string, input: Partial<ScheduleInput>): Promise<ScheduleMutation>
  setEnabled(id: string, enabled: boolean): Promise<ScheduleMutation>
  remove(id: string): Promise<ScheduleRemove>
  runNow(id: string): Promise<ScheduleRun>
}

export function createScheduleClient(): ScheduleBridge {
  return window.yan.schedule
}

export function loadTasks(bridge: ScheduleBridge): Promise<ScheduledTask[]> {
  return bridge.list()
}

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
