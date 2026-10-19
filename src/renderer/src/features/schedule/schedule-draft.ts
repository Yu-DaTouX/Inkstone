import { uiText } from '../../i18n/ui-text'
import {
  MAX_PROMPT_LENGTH,
  normalizeTrigger,
  type ScheduledTask,
  type ScheduleTrigger
} from '../../../../shared/schedule'

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

export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
const WEEKDAY_SET = '1,2,3,4,5'

export function blankDraft(cwd = ''): TaskDraft {
  return { name: '', prompt: '', model: '', cwd, kind: 'daily', time: '09:00', days: [1], minutes: 60, at: '' }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

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

export function triggerFromDraft(draft: TaskDraft): ScheduleTrigger {
  if (draft.kind === 'daily') return { kind: 'daily', time: draft.time }
  if (draft.kind === 'weekdays') return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: draft.time }
  if (draft.kind === 'weekly') return { kind: 'weekly', days: draft.days, time: draft.time }
  if (draft.kind === 'interval') return { kind: 'interval', minutes: draft.minutes }
  return { kind: 'once', at: new Date(draft.at).getTime() }
}

export type DraftErrorCode = 'needPrompt' | 'needAt' | 'invalidTrigger'

export interface ScheduleInput {
  name?: string
  prompt: string
  cwd?: string
  model?: string
  trigger: ScheduleTrigger
}

export type DraftCheck = { ok: true; input: ScheduleInput } | { ok: false; code: DraftErrorCode; message: string }

export function checkDraft(draft: TaskDraft): DraftCheck {
  const prompt = draft.prompt.trim()
  if (!prompt) return { ok: false, code: 'needPrompt', message: 'needPrompt' }
  if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, code: 'invalidTrigger', message: uiText('sched.promptTooLong', { max: MAX_PROMPT_LENGTH }) }
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
