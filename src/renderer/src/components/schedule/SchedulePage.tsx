import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { useStore } from '../../state/store'
import { describeTrigger, type ScheduledTask, type ScheduleTrigger } from '../../../../shared/schedule'
import { Badge, Button, EmptyState, Field, IconButton, Input, Segmented, Select, Switch, Textarea } from '../ui'
import { useConfirm } from '../ui/confirm'

type Kind = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once'
interface Draft { name: string; prompt: string; model: string; cwd: string; kind: Kind; time: string; days: number[]; minutes: number; at: string }

const DAY_KEYS: MessageKey[] = ['sched.d0', 'sched.d1', 'sched.d2', 'sched.d3', 'sched.d4', 'sched.d5', 'sched.d6']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

const blank = (): Draft => ({ name: '', prompt: '', model: '', cwd: '', kind: 'daily', time: '09:00', days: [1], minutes: 60, at: '' })

function toDraft(task: ScheduledTask): Draft {
  const base = { ...blank(), name: task.name, prompt: task.prompt, model: task.model ?? '', cwd: task.cwd ?? '' }
  const tr = task.trigger
  if (tr.kind === 'daily') return { ...base, kind: 'daily', time: tr.time }
  if (tr.kind === 'weekly') return tr.days.join(',') === '1,2,3,4,5' ? { ...base, kind: 'weekdays', time: tr.time } : { ...base, kind: 'weekly', days: tr.days, time: tr.time }
  if (tr.kind === 'interval') return { ...base, kind: 'interval', minutes: tr.minutes }
  const d = new Date(tr.at), pad = (n: number): string => String(n).padStart(2, '0')
  return { ...base, kind: 'once', at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

function toTrigger(d: Draft): ScheduleTrigger {
  if (d.kind === 'daily') return { kind: 'daily', time: d.time }
  if (d.kind === 'weekdays') return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: d.time }
  if (d.kind === 'weekly') return { kind: 'weekly', days: d.days, time: d.time }
  if (d.kind === 'interval') return { kind: 'interval', minutes: d.minutes }
  return { kind: 'once', at: new Date(d.at).getTime() }
}

const when = (ms: number | undefined): string => ms ? new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export function SchedulePage({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT()
  const confirm = useConfirm()
  const models = useStore(s => s.models)
  const cwdDefault = useStore(s => s.settings?.cwd ?? '')
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(open, () => (editing ? setEditing(null) : onClose()))
  useFocusTrap(panel, open, isTop)
  const load = useCallback(() => { void window.yan.schedule.list().then(setTasks).catch(() => undefined) }, [])
  useEffect(() => {
    if (!open) { setEditing(null); setError(''); return }
    load()
    const timer = setInterval(load, 15_000)
    const release = useStore.getState().acquireOverlayBlocker('schedule')
    return () => { clearInterval(timer); release() }
  }, [open, load])
  if (!open) return null

  const act = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(id); setError('')
    try { const r = await fn(); if (!r.ok) setError(r.error ?? t('sched.failed')) } catch (e) { setError(String(e)) } finally { setBusy(''); load() }
  }
  const save = async (): Promise<void> => {
    if (!editing) return
    const d = editing.draft
    setError('')
    if (!d.prompt.trim()) { setError(t('sched.needPrompt')); return }
    if (d.kind === 'once' && !d.at) { setError(t('sched.needAt')); return }
    const input = { name: d.name.trim() || undefined, prompt: d.prompt, model: d.model, cwd: d.cwd.trim(), trigger: toTrigger(d) }
    setBusy('save')
    try {
      const r = editing.id ? await window.yan.schedule.update(editing.id, input) : await window.yan.schedule.create(input)
      if (!r.ok) { setError(r.error ?? t('sched.failed')); return }
      setEditing(null); load()
    } catch (e) { setError(String(e)) } finally { setBusy('') }
  }
  const set = (patch: Partial<Draft>): void => setEditing(e => e ? { ...e, draft: { ...e.draft, ...patch } } : e)

  return <div className="settings-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="sched" ref={panel} role="dialog" aria-modal="true" aria-label={t('sched.title')} data-testid="schedule-page">
      <header className="sched-head">
        <h2 className="sched-title">{editing ? t(editing.id ? 'sched.edit' : 'sched.new') : t('sched.title')}</h2>
        {editing ? null : <Button variant="primary" size="sm" data-testid="schedule-new" onClick={() => setEditing({ draft: { ...blank(), cwd: '' } })}>{t('sched.new')}</Button>}
        <IconButton icon="close" size="sm" label={t('q.close')} onClick={onClose} />
      </header>
      {editing ? <form className="sched-form" onSubmit={e => { e.preventDefault(); void save() }}>
        <Field label={t('sched.name')}><Input value={editing.draft.name} placeholder={t('sched.namePh')} data-testid="schedule-name" onChange={e => set({ name: e.target.value })} /></Field>
        <Field label={t('sched.prompt')} hint={t('sched.promptHint')}><Textarea rows={6} value={editing.draft.prompt} placeholder={t('sched.promptPh')} data-testid="schedule-prompt" onChange={e => set({ prompt: e.target.value })} /></Field>
        <div className="sched-row">
          <Field label={t('sched.model')}>
            <Select value={editing.draft.model} data-testid="schedule-model" onChange={e => set({ model: e.target.value })}>
              <option value="">{t('sched.modelDefault')}</option>
              {models.map(m => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name || m.id}</option>)}
            </Select>
          </Field>
          <Field label={t('sched.cwd')}><Input value={editing.draft.cwd} placeholder={cwdDefault || t('sched.cwdPh')} data-testid="schedule-cwd" onChange={e => set({ cwd: e.target.value })} /></Field>
        </div>
        <div className="sched-trigger">
          <span className="ui-field-label">{t('sched.trigger')}</span>
          <Segmented<Kind> label={t('sched.trigger')} size="sm" value={editing.draft.kind} onChange={kind => set({ kind })} options={[
            { value: 'daily', label: t('sched.k.daily') }, { value: 'weekdays', label: t('sched.k.weekdays') }, { value: 'weekly', label: t('sched.k.weekly') },
            { value: 'interval', label: t('sched.k.interval') }, { value: 'once', label: t('sched.k.once') }
          ]} />
          <div className="sched-when">
            {editing.draft.kind === 'weekly' ? <div className="sched-days" role="group" aria-label={t('sched.days')}>
              {WEEK_ORDER.map(d => <Button key={d} size="sm" active={editing.draft.days.includes(d)} onClick={() => set({ days: editing.draft.days.includes(d) ? editing.draft.days.filter(x => x !== d) : [...editing.draft.days, d] })}>{t(DAY_KEYS[d])}</Button>)}
            </div> : null}
            {['daily', 'weekdays', 'weekly'].includes(editing.draft.kind) ? <Input type="time" value={editing.draft.time} aria-label={t('sched.time')} data-testid="schedule-time" onChange={e => set({ time: e.target.value })} /> : null}
            {editing.draft.kind === 'interval' ? <><span>{t('sched.every')}</span><Input type="number" min={5} value={editing.draft.minutes} aria-label={t('sched.minutes')} data-testid="schedule-minutes" onChange={e => set({ minutes: Number(e.target.value) })} /><span>{t('sched.minutes')}</span></> : null}
            {editing.draft.kind === 'once' ? <Input type="datetime-local" value={editing.draft.at} aria-label={t('sched.at')} data-testid="schedule-at" onChange={e => set({ at: e.target.value })} /> : null}
          </div>
        </div>
        <p className="ui-row-desc">{t('sched.notice')}</p>
        {error ? <p className="agent-workspace-error" role="alert">{error}</p> : null}
        <footer className="sched-foot">
          <Button onClick={() => { setEditing(null); setError('') }}>{t('sched.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy === 'save'} data-testid="schedule-save">{t(editing.id ? 'sched.save' : 'sched.create')}</Button>
        </footer>
      </form> : <div className="sched-list">
        {error ? <p className="agent-workspace-error" role="alert">{error}</p> : null}
        {tasks.length === 0 ? <EmptyState icon="history" title={t('sched.empty')}>{t('sched.emptyBody')}</EmptyState> : null}
        {tasks.map(task => <article key={task.id} className="sched-card" data-testid={`schedule-${task.id}`} data-state={task.pendingApproval ? 'pending' : task.enabled ? 'on' : 'off'}>
          <div className="sched-card-main">
            <div className="sched-card-name">
              <strong>{task.name}</strong>
              {task.pendingApproval ? <Badge tone="warn">{t('sched.pending')}</Badge> : task.enabled ? null : <Badge>{t('sched.paused')}</Badge>}
              {task.createdBy === 'model' ? <Badge tone="accent">{t('sched.byModel')}</Badge> : null}
            </div>
            <p className="sched-card-prompt" title={task.prompt}>{task.prompt}</p>
            <p className="sched-card-meta">
              <span>{describeTrigger(task.trigger)}</span>
              {task.enabled ? <span>{t('sched.next', { when: when(task.nextRunAt) })}</span> : null}
              {task.lastRunAt ? <span>{t('sched.last', { when: when(task.lastRunAt) })}</span> : null}
              {task.model ? <span title={task.model}>{task.model.slice(task.model.indexOf('/') + 1)}</span> : null}
            </p>
            {task.lastError ? <p className="sched-card-error" title={task.lastError}>{t('sched.lastError', { error: task.lastError })}</p> : null}
          </div>
          <div className="sched-card-actions">
            <Switch checked={task.enabled} label={t('sched.enable')} disabled={busy === task.id} testId={`schedule-switch-${task.id}`} onChange={on => void act(task.id, async () => (await window.yan.schedule.setEnabled(task.id, on)))} />
            <Button size="sm" variant="ghost" disabled={busy === task.id} onClick={() => void act(task.id, async () => { const r = await window.yan.schedule.runNow(task.id); if (r.ok) onClose(); return r })}>{t('sched.runNow')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing({ id: task.id, draft: toDraft(task) })}>{t('sched.edit')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void (async () => { if (await confirm({ title: t('sched.deleteTitle'), body: task.name, confirmLabel: t('sched.delete'), tone: 'danger' })) void act(task.id, async () => ({ ok: (await window.yan.schedule.remove(task.id)).ok })) })()}>{t('sched.delete')}</Button>
          </div>
        </article>)}
      </div>}
    </div>
  </div>
}
