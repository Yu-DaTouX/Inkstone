import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { CalendarClock, Plus } from 'lucide-react'
import { type ScheduledTask, type ScheduleTrigger } from '../../../../shared/schedule'
import { useI18n, useT, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Dialog,
  EmptyState,
  Input,
  Label,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Notice,
  PageHeader,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextArea,
  TextField
} from '../../ui'
import {
  blankDraft,
  checkDraft,
  draftFromTask,
  WEEK_ORDER,
  type TaskDraft,
  type TriggerKind
} from './schedule-draft'
import {
  createScheduleClient,
  loadTasks,
  removeTask,
  runTaskNow,
  saveTask,
  setTaskEnabled,
  type ScheduleBridge
} from './schedule-client'
import './schedule-tasks.css'

export function formatWhen(ms: number | undefined, lang: string): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function shortModel(model: string): string {
  const at = model.indexOf('/')
  return at >= 0 ? model.slice(at + 1) : model
}

const KIND_ORDER: readonly TriggerKind[] = ['daily', 'weekdays', 'weekly', 'interval', 'once']
const KIND_LABEL: Record<TriggerKind, Parameters<TFunc>[0]> = {
  daily: 'sched.k.daily',
  weekdays: 'sched.k.weekdays',
  weekly: 'sched.k.weekly',
  interval: 'sched.k.interval',
  once: 'sched.k.once'
}
const DAY_KEYS: Parameters<TFunc>[0][] = ['sched.d0', 'sched.d1', 'sched.d2', 'sched.d3', 'sched.d4', 'sched.d5', 'sched.d6']

export function describeTriggerText(trigger: ScheduleTrigger, t: TFunc, lang: string): string {
  if (trigger.kind === 'daily') return t('sched.desc.daily', { time: trigger.time })
  if (trigger.kind === 'weekly') {
    const days = [...trigger.days].sort()
    const key = days.join(',')
    if (key === '1,2,3,4,5') return t('sched.desc.weekdays', { time: trigger.time })
    if (key === '0,6') return t('sched.desc.weekend', { time: trigger.time })
    if (days.length === 7) return t('sched.desc.daily', { time: trigger.time })
    const names = days.map((day) => t(DAY_KEYS[day])).join(lang === 'en-US' ? ', ' : '、')
    return t('sched.desc.weekly', { days: names, time: trigger.time })
  }
  if (trigger.kind === 'interval') {
    return trigger.minutes % 60 === 0
      ? t('sched.desc.intervalHours', { n: String(trigger.minutes / 60) })
      : t('sched.desc.intervalMinutes', { n: String(trigger.minutes) })
  }
  return t('sched.desc.once', { when: formatWhen(trigger.at, lang) })
}

export interface ScheduleTaskCardProps {
  task: ScheduledTask
  busy: boolean
  lang: string
  t: TFunc
  onToggle(enabled: boolean): void
  onRunNow(): void
  onEdit(): void
  onDelete(): void
}

export function ScheduleTaskCard({ task, busy, lang, t, onToggle, onRunNow, onEdit, onDelete }: ScheduleTaskCardProps): ReactElement {
  return (
    <Card
      as="li"
      className="sched-task"
      data-testid={`schedule-${task.id}`}
      data-state={task.pendingApproval ? 'pending' : task.enabled ? 'on' : 'off'}
    >
      <div className="sched-task-main">
        <div className="sched-task-name">
          <strong className="sched-task-title">{task.name}</strong>
          {task.pendingApproval ? (
            <Badge tone="stall">{t('sched.pending')}</Badge>
          ) : task.enabled ? null : (
            <Badge>{t('sched.paused')}</Badge>
          )}
          {task.createdBy === 'model' ? <Badge tone="accent">{t('sched.byModel')}</Badge> : null}
        </div>
        <p className="sched-task-prompt" title={task.prompt}>
          {task.prompt}
        </p>
        <p className="sched-task-meta">
          <span>{describeTriggerText(task.trigger, t, lang)}</span>
          {task.enabled && task.nextRunAt ? <span>{t('sched.next', { when: formatWhen(task.nextRunAt, lang) })}</span> : null}
          {task.lastRunAt ? <span>{t('sched.last', { when: formatWhen(task.lastRunAt, lang) })}</span> : null}
          {task.cwd ? (
            <span className="sched-task-cwd" title={task.cwd}>
              {t('sched.cwdMeta', { cwd: task.cwd })}
            </span>
          ) : null}
          {task.model ? (
            <span className="sched-task-model" title={task.model}>
              {shortModel(task.model)}
            </span>
          ) : null}
        </p>
        {task.lastError ? (
          <Notice tone="fail" compact role="status" className="sched-task-error">
            <span title={task.lastError}>{t('sched.lastError', { error: task.lastError })}</span>
          </Notice>
        ) : null}
      </div>
      <div className="sched-task-actions">
        <Switch isSelected={task.enabled} isDisabled={busy} onChange={onToggle} aria-label={t('sched.enable')} />
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onRunNow}>
          {t('sched.runNow')}
        </Button>
        <Button size="sm" variant="ghost" onPress={onEdit}>
          {t('sched.edit')}
        </Button>
        <Button size="sm" variant="ghost" onPress={onDelete}>
          {t('sched.delete')}
        </Button>
      </div>
    </Card>
  )
}

interface EditorProps {
  draft: TaskDraft
  editingId?: string
  busy: boolean
  error: string
  models: { provider: string; id: string; name?: string }[]
  t: TFunc
  onChange(patch: Partial<TaskDraft>): void
  onCancel(): void
  onSubmit(): void
}

function ScheduleEditor({ draft, editingId, busy, error, models, t, onChange, onCancel, onSubmit }: EditorProps): ReactElement {
  return (
    <form
      className="sched-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextField
        label={t('sched.name')}
        placeholder={t('sched.namePh')}
        value={draft.name}
        data-testid="schedule-name"
        onChange={(value) => onChange({ name: value })}
      />
      <TextArea
        label={t('sched.prompt')}
        description={t('sched.promptHint')}
        placeholder={t('sched.promptPh')}
        rows={6}
        value={draft.prompt}
        data-testid="schedule-prompt"
        onChange={(value) => onChange({ prompt: value })}
      />
      <div className="sched-form-row">
        <Select
          label={t('sched.model')}
          selectedKey={draft.model}
          data-testid="schedule-model"
          onSelectionChange={(key) => onChange({ model: String(key ?? '') })}
        >
          <ListBoxItem id="">{t('sched.modelDefault')}</ListBoxItem>
          {models.map((model) => (
            <ListBoxItem key={`${model.provider}/${model.id}`} id={`${model.provider}/${model.id}`}>
              {model.name || model.id}
            </ListBoxItem>
          ))}
        </Select>
        <TextField
          label={t('sched.cwd')}
          placeholder={t('sched.cwdPh')}
          value={draft.cwd}
          data-testid="schedule-cwd"
          onChange={(value) => onChange({ cwd: value })}
        />
      </div>
      <div className="sched-trigger">
        <RadioGroup label={t('sched.trigger')} value={draft.kind} onChange={(value) => onChange({ kind: value as TriggerKind })}>
          <div className="sched-kind">
            {KIND_ORDER.map((kind) => (
              <Radio key={kind} value={kind}>
                {t(KIND_LABEL[kind])}
              </Radio>
            ))}
          </div>
        </RadioGroup>
        <div className="sched-when">
          {draft.kind === 'weekly' ? (
            <CheckboxGroup
              aria-label={t('sched.days')}
              value={draft.days.map(String)}
              onChange={(keys) => onChange({ days: keys.map(Number) })}
            >
              <div className="sched-days">
                {WEEK_ORDER.map((day) => (
                  <Checkbox key={day} value={String(day)}>
                    {t(DAY_KEYS[day])}
                  </Checkbox>
                ))}
              </div>
            </CheckboxGroup>
          ) : null}
          {draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'weekly' ? (
            <ClockField label={t('sched.time')} value={draft.time} onChange={(time) => onChange({ time })} />
          ) : null}
          {draft.kind === 'interval' ? (
            <div className="sched-interval">
              <span>{t('sched.every')}</span>
              <Input
                className="ui-input"
                type="number"
                min={5}
                value={draft.minutes}
                aria-label={t('sched.minutes')}
                data-testid="schedule-minutes"
                onChange={(event) => onChange({ minutes: Number(event.target.value) })}
              />
              <span>{t('sched.minutes')}</span>
            </div>
          ) : null}
          {draft.kind === 'once' ? (
            <TextField label={t('sched.at')} value={draft.at} onChange={(value) => onChange({ at: value })}>
              <Label className="ui-field__label">{t('sched.at')}</Label>
              <Input className="ui-input" type="datetime-local" data-testid="schedule-at" />
            </TextField>
          ) : null}
        </div>
      </div>
      <Notice tone="info" compact className="sched-notice">
        {t('sched.notice')}
      </Notice>
      {error ? (
        <Notice tone="fail" className="sched-form-error">
          {error}
        </Notice>
      ) : null}
      <footer className="sched-form-foot">
        <Button onPress={onCancel}>{t('sched.cancel')}</Button>
        <Button type="submit" variant="primary" isPending={busy} data-testid="schedule-save">
          {t(editingId ? 'sched.save' : 'sched.create')}
        </Button>
      </footer>
    </form>
  )
}

export interface ScheduleTasksPageProps {
  client?: ScheduleBridge
}

export function ScheduleTasksPage({ client }: ScheduleTasksPageProps = {}): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const models = useStore((s) => s.models)
  const defaultCwd = useStore((s) => s.settings?.cwd ?? '')
  const schedule = useMemo<ScheduleBridge>(() => client ?? createScheduleClient(), [client])

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<{ id?: string; draft: TaskDraft } | null>(null)
  const [editorError, setEditorError] = useState('')
  const [confirming, setConfirming] = useState<ScheduledTask | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTasks(await loadTasks(schedule))
      setError('')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setLoading(false)
    }
  }, [schedule])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refresh()
    }, 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const run = async (id: string, work: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      const result = await work()
      if (!result.ok) setError(result.error ?? t('sched.failed'))
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy('')
    }
  }

  const submit = async (): Promise<void> => {
    if (!editing) return
    const checked = checkDraft(editing.draft, t)
    if (!checked.ok) {
      setEditorError(checked.message)
      return
    }
    setBusy('save')
    setEditorError('')
    try {
      const result = await saveTask(schedule, editing.id, checked.input)
      if (!result.ok) {
        setEditorError(result.error ?? t('sched.failed'))
        return
      }
      setEditing(null)
      await refresh()
    } catch (cause) {
      setEditorError(String(cause))
    } finally {
      setBusy('')
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const task = confirming
    if (!task) return
    await run(task.id, () => removeTask(schedule, task.id))
    setConfirming(null)
  }

  return (
    <div className="sched-page" data-testid="v3-schedule-page">
      <PageHeader
        className="sched-page-head"
        title={
          <span className="sched-page-title">
            <CalendarClock size={18} aria-hidden /> {t('sched.title')}
          </span>
        }
        actions={
          <Button
            variant="primary"
            icon={<Plus size={15} aria-hidden />}
            data-testid="schedule-new"
            onPress={() => {
              setEditorError('')
              setEditing({ draft: blankDraft(defaultCwd) })
            }}
          >
            {t('sched.new')}
          </Button>
        }
      />

      {error ? (
        <Notice tone="fail" className="sched-page-error">
          {error}
        </Notice>
      ) : null}

      <Notice tone="info" compact className="sched-page-notice">
        {t('sched.notice')}
      </Notice>

      <div className="sched-list" aria-busy={loading || undefined}>
        {tasks.length === 0 && !loading ? (
          <EmptyState
            className="sched-empty"
            data-testid="schedule-empty"
            icon={<CalendarClock size={20} />}
            title={t('sched.empty')}
            description={t('sched.emptyBody')}
          />
        ) : (
          <ul className="sched-task-list">
            {tasks.map((task) => (
              <ScheduleTaskCard
                key={task.id}
                task={task}
                busy={busy === task.id || busy === 'save'}
                lang={lang}
                t={t}
                onToggle={(enabled) => void run(task.id, () => setTaskEnabled(schedule, task.id, enabled))}
                onRunNow={() => void run(task.id, () => runTaskNow(schedule, task.id))}
                onEdit={() => {
                  setEditorError('')
                  setEditing({ id: task.id, draft: draftFromTask(task) })
                }}
                onDelete={() => setConfirming(task)}
              />
            ))}
          </ul>
        )}
      </div>

      <ModalOverlay
        isDismissable
        isOpen={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <Modal>
          <Dialog title={editing?.id ? t('sched.edit') : t('sched.new')} closeLabel={t('sched.cancel')}>
            {editing ? (
              <ScheduleEditor
                draft={editing.draft}
                editingId={editing.id}
                busy={busy === 'save'}
                error={editorError}
                models={models}
                t={t}
                onChange={(patch) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))}
                onCancel={() => {
                  setEditorError('')
                  setEditing(null)
                }}
                onSubmit={() => void submit()}
              />
            ) : null}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay
        isDismissable
        isOpen={!!confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <Modal>
          <Dialog title={t('sched.deleteTitle')} closeLabel={t('sched.cancel')} data-testid="schedule-delete-dialog">
            <p className="sched-confirm-body">{confirming?.name ?? ''}</p>
            <footer className="sched-confirm-foot">
              <Button onPress={() => setConfirming(null)}>{t('sched.cancel')}</Button>
              <Button variant="danger" isDisabled={busy === confirming?.id} onPress={() => void confirmDelete()}>
                {t('sched.delete')}
              </Button>
            </footer>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  )
}

function normalizeClock(raw: string): string | null {
  const match = /^\s*(\d{1,2})(?:[:：.]?(\d{2}))?\s*$/.exec(raw)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? '0')
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function ClockField({ label, value, onChange }: { label: string; value: string; onChange: (time: string) => void }): ReactElement {
  const [raw, setRaw] = useState(value)
  useEffect(() => setRaw(value), [value])
  const invalid = normalizeClock(raw) === null
  const commit = (): void => {
    const next = normalizeClock(raw)
    if (!next) return
    setRaw(next)
    if (next !== value) onChange(next)
  }
  return (
    <TextField label={label} value={raw} onChange={setRaw} onBlur={commit} isInvalid={invalid}>
      <Label className="ui-field__label">{label}</Label>
      <Input
        className="ui-input sched-clock"
        inputMode="numeric"
        maxLength={5}
        placeholder="09:00"
        data-testid="schedule-time"
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
    </TextField>
  )
}
