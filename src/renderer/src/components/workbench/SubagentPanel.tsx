import { subagentModelError } from '../../../../shared/subagent-pi-launch'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { modelKey, type ModelChoice } from '../../../../shared/model-selection'
import { ModelCatalog } from '../ModelCatalog'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { AgentMessageStream } from '../chat/AgentMessageStream'
import { SubagentGroup } from '../chat/SubagentCards'
import { Button, EmptyState, Field, Select, Textarea } from '../ui'
import type { SubagentRun } from '../../../../shared/ipc'

/** 当前会话的轻量委派；不查询 Hub、不轮询任务收件箱。 */
export function SubagentPanel({ initialRun, onOpenRun, onTitleChange }: {
  initialRun?: string; onOpenRun?(key: string): void; onTitleChange?(title: string): void
}) {
  const t = useT()
  const session = useStore(s => s.session)
  const settings = useStore(s => s.settings)
  const runner = useStore(s => s.activeRunnerId)
  const runs = useStore(s => s.subagents)
  const models = useStore(s => s.models)
  const load = useStore(s => s.loadSubagents)
  const [task, setTask] = useState('')
  const [model, setModel] = useState<ModelChoice | 'follow' | undefined>(settings?.lastSubagentModel)
  const [modelOpen, setModelOpen] = useState(false)
  const [anchor, setAnchor] = useState({ right: 8, bottom: 8, maxHeight: 480 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const patchSettings = useStore(s => s.patchSettings)
  const { isTop } = useModalLayer(modelOpen, () => setModelOpen(false))
  useFocusTrap(menu, modelOpen, isTop)
  const [isolation, setIsolation] = useState<SubagentRun['isolation']>('shared-cwd')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentModel = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const modelChoice = model === 'follow' ? session?.model : model ?? session?.model
  const resolvedModel = modelChoice ? `${modelChoice.provider}/${modelChoice.id}` : undefined
  const selectedModel = models.find(item => `${item.provider}/${item.id}` === resolvedModel)
  const modelLabel = selectedModel?.name || resolvedModel || t('delegate.noModel')
  const cwd = session?.cwd || settings?.cwd || ''
  const readOnlyError = subagentModelError(resolvedModel, true)
  const validationError = isolation === 'controlled-cwd' && readOnlyError ? t('delegate.ccReadOnly')
    : !resolvedModel ? t('delegate.noModel') : !selectedModel ? t('models.unavailable') : ''
  const owned = runs.filter(run => (run.parentSessionId && [session?.sessionId, session?.conversationId].includes(run.parentSessionId)) || (runner && run.parentRunId === runner))
  const selected = owned.find(run => `subagent:${run.id}` === initialRun)
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (initialized.current || !settings || !session?.model || session.model.id === 'unknown') return
    initialized.current = true
    setModel(settings.lastSubagentModel ?? { provider: session.model.provider, id: session.model.id, name: session.model.name })
  }, [settings, session?.model])
  useEffect(() => {
    if (!modelOpen) return
    const release = useStore.getState().acquireOverlayBlocker('delegate-model')
    const close = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setModelOpen(false) }
    document.addEventListener('mousedown', close)
    return () => { release(); document.removeEventListener('mousedown', close) }
  }, [modelOpen])
  useLayoutEffect(() => {
    if (!modelOpen) return
    const measure = () => {
      const r = trigger.current?.getBoundingClientRect(); if (!r) return
      const below = innerHeight - r.bottom - 12, above = r.top - 52
      const bottom = below >= Math.min(480, above) ? 8 : innerHeight - r.top + 6
      setAnchor({ right: Math.max(8, innerWidth - r.right), bottom, maxHeight: Math.max(160, Math.min(560, below >= Math.min(480, above) ? below : above)) })
    }
    measure(); window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [modelOpen])
  useEffect(() => { if (selected) onTitleChange?.(selected.task.slice(0, 30)) }, [selected?.task, onTitleChange])
  const start = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!task.trim() || busy || validationError) return
    setBusy(true); setError('')
    try {
      const result = await window.yan.subagents.start(task.trim(), resolvedModel, isolation)
      if (!result.ok || !result.run) { setError(result.error ?? t('delegate.failed')); return }
      await load(); setTask(''); onOpenRun?.(`subagent:${result.run.id}`)
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  if (initialRun) return selected ? <section className="agent-workspace" data-testid="subagent-detail"><AgentMessageStream run={selected} /></section> : <EmptyState icon="agent" title={t('delegate.missing')} />
  return <section className="agent-workspace" data-testid="subagent-panel">
    <form className="delegate-form" onSubmit={event => void start(event)}>
      <Field label={t('delegate.model')}><Button ref={trigger} aria-label={t('delegate.model')} title={model === 'follow' ? `${t('delegate.follow')} · ${currentModel}` : `${modelLabel} · ${resolvedModel}`}
        aria-haspopup="dialog" aria-expanded={modelOpen} data-testid="delegate-model" onClick={() => setModelOpen(v => !v)}>
        {model === 'follow' ? t('delegate.follow') : modelLabel}
      </Button></Field>
      {modelOpen ? createPortal(<div className="mt-pop delegate-model-menu" ref={menu} role="dialog" aria-modal="true" aria-label={t('delegate.model')} data-testid="delegate-model-menu" style={anchor}>
        <Button size="sm" variant="ghost" active={model === 'follow'} data-testid="delegate-follow" onClick={() => {
          void patchSettings({ lastSubagentModel: 'follow' }).then(() => { setModel('follow'); setModelOpen(false) }).catch(e => setError(String(e)))
        }}>{t('delegate.follow')} · {currentModel || t('delegate.noModel')}</Button>
        <ModelCatalog key={modelChoice ? modelKey(modelChoice) : 'empty'} current={modelChoice} compact={anchor.maxHeight < 480} onSelect={async choice => {
          await patchSettings({ lastSubagentModel: { provider: choice.provider, id: choice.id, name: choice.name } })
          setModel(choice); setModelOpen(false); return true
        }} />
      </div>, document.body) : null}
      <p className="ui-row-desc delegate-target" data-testid="delegate-target">{modelLabel}<br />{cwd || t('delegate.noFolder')}</p>
      <Field label={t('delegate.task')}><Textarea rows={3} data-testid="delegate-task" aria-label={t('delegate.task')} placeholder={t('delegate.task')} value={task} onChange={event => setTask(event.target.value)} /></Field>
      <Field label={t('delegate.scope')}><Select aria-label={t('delegate.scope')} data-testid="delegate-scope" value={isolation} onChange={event => setIsolation(event.target.value as SubagentRun['isolation'])}>
        <option value="shared-cwd">{t('delegate.folder')}</option><option value="controlled-cwd" disabled={!!readOnlyError}>{t('sa.readOnly')}</option><option value="worktree">{t('delegate.worktree')}</option>
      </Select></Field>
      {readOnlyError ? <p className="ui-row-desc" data-testid="delegate-readonly-hint">{t('delegate.ccReadOnly')}</p> : null}
      {validationError ? <p className="agent-workspace-error" role="alert">{validationError}</p> : null}
      <div className="hub-row"><Button type="submit" variant="primary" disabled={busy || !task.trim() || !!validationError}>{t('delegate.start')}</Button></div>
    </form>
    {error ? <p className="agent-workspace-error" role="alert">{error}</p> : null}
    <SubagentGroup runs={owned} />
  </section>
}
