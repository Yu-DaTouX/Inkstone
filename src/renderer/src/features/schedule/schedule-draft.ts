/**
 * 定时任务编辑器的草稿与触发规则转换（纯函数，v3 定时页专用）。
 *
 * 校验一律复用 `shared/schedule` 的 `normalizeTrigger` / 指令长度上限 / 最小间隔，
 * 界面不自造第二套规则，也不新增任务状态机：这里只把 `ScheduledTask` 与编辑器字段
 * 相互转换，并把 IPC 输入规整成服务端 `check()` 期望的形状。
 */
import {
  MAX_PROMPT_LENGTH,
  normalizeTrigger,
  type ScheduledTask,
  type ScheduleTrigger
} from '../../../../shared/schedule'

/** 编辑器把「工作日」从 weekly 里拆出来，便于用一组互斥选项直接表达。 */
export type TriggerKind = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once'

export interface TaskDraft {
  name: string
  prompt: string
  model: string
  cwd: string
  kind: TriggerKind
  time: string
  days: number[]
  minutes: number
  at: string
}

/** 星期按钮顺序：周一到周日，0 = 周日放最后。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
const WEEKDAY_SET = '1,2,3,4,5'

export function blankDraft(cwd = ''): TaskDraft {
  return { name: '', prompt: '', model: '', cwd, kind: 'daily', time: '09:00', days: [1], minutes: 60, at: '' }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 绝对毫秒 → `datetime-local` 需要的本地时间字符串。 */
export function localDateTimeValue(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function draftFromTask(task: ScheduledTask): TaskDraft {
  const base: TaskDraft = {
    ...blankDraft(task.cwd ?? ''),
    name: task.name,
    prompt: task.prompt,
    model: task.model ?? ''
  }
  const trigger = task.trigger
  if (trigger.kind === 'daily') return { ...base, kind: 'daily', time: trigger.time }
  if (trigger.kind === 'weekly') {
    return trigger.days.join(',') === WEEKDAY_SET
      ? { ...base, kind: 'weekdays', time: trigger.time }
      : { ...base, kind: 'weekly', days: trigger.days, time: trigger.time }
  }
  if (trigger.kind === 'interval') return { ...base, kind: 'interval', minutes: trigger.minutes }
  return { ...base, kind: 'once', at: localDateTimeValue(trigger.at) }
}

/** 草稿 → 触发规则；时间 / 星期不合法时交给 `normalizeTrigger` 报错。 */
export function triggerFromDraft(draft: TaskDraft): ScheduleTrigger {
  if (draft.kind === 'daily') return { kind: 'daily', time: draft.time }
  if (draft.kind === 'weekdays') return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: draft.time }
  if (draft.kind === 'weekly') return { kind: 'weekly', days: draft.days, time: draft.time }
  if (draft.kind === 'interval') return { kind: 'interval', minutes: draft.minutes }
  return { kind: 'once', at: new Date(draft.at).getTime() }
}

export type DraftErrorCode = 'needPrompt' | 'needAt' | 'invalidTrigger'

/** 提交给 IPC 的输入；与服务端 `ScheduleService.check()` 的字段一致。 */
export interface ScheduleInput {
  name?: string
  prompt: string
  cwd?: string
  model?: string
  trigger: ScheduleTrigger
}

export type DraftCheck = { ok: true; input: ScheduleInput } | { ok: false; code: DraftErrorCode; message: string }

/**
 * 提交前校验。规则只来自 `shared/schedule`：
 *   · 指令必填、不超过 `MAX_PROMPT_LENGTH`；
 *   · 单次触发要有有效时间；
 *   · 触发方式经 `normalizeTrigger` 规整（最小间隔、HH:MM、至少一天都由它判）。
 * 名称 / cwd / model 的空值在这里去掉，避免把空串当覆盖值发给服务端。
 */
export function checkDraft(draft: TaskDraft): DraftCheck {
  const prompt = draft.prompt.trim()
  if (!prompt) return { ok: false, code: 'needPrompt', message: 'needPrompt' }
  if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, code: 'invalidTrigger', message: `指令不能超过 ${MAX_PROMPT_LENGTH} 个字符` }
  if (draft.kind === 'once') {
    const at = new Date(draft.at).getTime()
    if (!draft.at || !Number.isFinite(at) || at <= 0) return { ok: false, code: 'needAt', message: 'needAt' }
  }
  const normalized = normalizeTrigger(triggerFromDraft(draft))
  if (!normalized.ok) return { ok: false, code: 'invalidTrigger', message: normalized.error }
  const name = draft.name.trim()
  const cwd = draft.cwd.trim()
  const model = draft.model.trim()
  return {
    ok: true,
    input: {
      ...(name ? { name } : {}),
      prompt,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      trigger: normalized.trigger
    }
  }
}
