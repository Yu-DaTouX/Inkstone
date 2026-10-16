/**
 * `yan schedule …`：模型创建与管理定时任务。
 *
 * 模型创建的任务先停着（待确认），用户在「定时任务」页确认启用后才会按时运行，
 * 因此模型不能让一段指令在无人值守时自行运行。暂停与删除不需要确认。
 */
import type { ScheduleService } from './schedule-service'
import { describeTrigger, type ScheduledTask, type ScheduleTrigger } from '../shared/schedule'

export class ScheduleCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 简写：--daily 09:00 / --weekdays 09:00 / --every 60（分钟）/ --at "2026-10-15 09:00"；也可直接给完整 trigger 对象。 */
function triggerFrom(params: Record<string, unknown>): unknown {
  if (params.trigger && typeof params.trigger === 'object') return params.trigger
  if (typeof params.daily === 'string') return { kind: 'daily', time: params.daily }
  if (typeof params.weekdays === 'string') return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: params.weekdays }
  if (params.every !== undefined) return { kind: 'interval', minutes: Number(params.every) }
  if (typeof params.at === 'string') return { kind: 'once', at: new Date(params.at.replace(' ', 'T')).getTime() }
  return undefined
}

const view = (task: ScheduledTask) => ({
  id: task.id,
  name: task.name,
  when: describeTrigger(task.trigger as ScheduleTrigger),
  status: task.pendingApproval ? 'pending-approval' : task.enabled ? 'enabled' : 'paused',
  lastRunAt: task.lastRunAt ?? null,
  lastError: task.lastError ?? null
})

export async function runScheduleCommand(
  service: ScheduleService,
  command: string,
  params: Record<string, unknown>,
  context: { cwd: string }
): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
  if (command === 'schedule.list') {
    const tasks = service.list()
    return { data: tasks.map(view), summary: { kind: 'schedule-list', count: tasks.length } }
  }
  if (command === 'schedule.create') {
    const created = await service.create({
      name: params.name,
      prompt: params.prompt,
      cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : context.cwd,
      model: params.model,
      trigger: triggerFrom(params)
    }, 'model')
    if (!created.ok) throw new ScheduleCommandError('schedule_invalid', created.error)
    return {
      data: {
        ...view(created.task),
        message: '已创建，但先停着：需要用户在「定时任务」页确认启用后才会按时运行。请告诉用户去确认。'
      },
      summary: { kind: 'schedule-create', id: created.task.id, status: 'pending-approval' }
    }
  }
  const id = typeof params.id === 'string' ? params.id.trim() : ''
  if (!id) throw new ScheduleCommandError('schedule_id_required', '缺少 --id')
  if (command === 'schedule.delete') {
    const ok = await service.remove(id)
    if (!ok) throw new ScheduleCommandError('schedule_not_found', '找不到这个定时任务')
    return { data: { id }, summary: { kind: 'schedule-delete', id } }
  }
  if (command === 'schedule.pause') {
    const result = await service.setEnabled(id, false)
    if (!result.ok) throw new ScheduleCommandError('schedule_not_found', result.error)
    return { data: view(result.task), summary: { kind: 'schedule-pause', id } }
  }
  throw new ScheduleCommandError('schedule_unknown', `未知的定时任务命令：${command}`)
}
