import { useEffect, useMemo, useRef, useState } from 'react'
import { HUB_CLI_PACKAGES, HUB_CLI_INSTALL_URL, HUB_LEGACY_AGENTS, type HubAgent, type HubAttachmentInput, type HubSnapshot } from '../../../../shared/agent-hub'
import type { AgentWorkspaceRun } from '../../../../shared/agent-workspace'
import { useT, type MessageKey, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, EmptyState, IconButton, Segmented, Select, Switch, Textarea } from '../ui'
import { AttachmentPicker, AttachmentTray, useAttachments } from './AgentAttachments'
import { AgentMark } from './AgentMark'

type Mode = 'terminal' | 'managed' | 'readonly'

const AGENT_STATUS: Record<string, MessageKey> = { queued: 'hub.status.queued', preparing: 'hub.status.preparing', running: 'hub.status.running', waiting_input: 'hub.status.waitingInput', needs_review: 'hub.status.needsReview', completed: 'hub.status.completed', failed: 'hub.status.failed', cancelled: 'hub.status.stopped', uncertain: 'hub.status.uncertain', working: 'hub.status.working', idle: 'hub.status.idle', starting: 'hub.status.preparing', done: 'hub.status.done', error: 'hub.status.failed', stopped: 'hub.status.stopped' }

/** 运行状态的显示名；未知状态原样显示 */
export function agentStatusLabel(t: TFunc, status: string): string { const key = AGENT_STATUS[status]; return key ? t(key) : status }
const AGENT_NAME: Record<string, string> = { pi: 'pi', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', grok: 'Grok', antigravity: 'Antigravity' }
const MODE_HINT: Record<Mode, MessageKey> = {
  terminal: 'hub.modeHint.terminal',
  managed: 'hub.modeHint.managed',
  readonly: 'hub.modeHint.readonly'
}

export function agentName(agent: string): string { return AGENT_NAME[agent] ?? agent }

/** 3 分钟前 / 2 小时前 / 10/1 */
function ago(t: TFunc, at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return ''
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return t('time.justNow')
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) })
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function statusTone(run: AgentWorkspaceRun): string {
  if (run.status === 'idle') return 'mute'
  if (run.status === 'failed' || run.status === 'error') return 'err'
  if (run.attention) return 'warn'
  if (run.live) return 'live'
  if (run.status === 'completed' || run.status === 'done') return 'ok'
  return 'mute'
}

/** The collaboration overview: start a run, then find it in the grouped list. Runs open in their own tiles. */
export function AgentHubHome({ snapshot, runs, sessionProject, onOpenRun, onRefresh }: {
  snapshot: HubSnapshot | null
  runs: AgentWorkspaceRun[]
  sessionProject?: string
  onOpenRun(key: string): void
  onRefresh(): Promise<void>
}) {
  const t = useT()
  const sessionId = useStore(s => s.session?.sessionId)
  const loadSubagents = useStore(s => s.loadSubagents)
  const [mode, setMode] = useState<Mode>('terminal')
  const [agent, setAgent] = useState<HubAgent | ''>('')
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [taskOpen, setTaskOpen] = useState(false)
  const createId = useRef<{ id: string; signature: string } | undefined>(undefined)
  const adapters = useMemo(() => (snapshot?.adapters ?? []).filter(a => a.agent !== 'pi' && !HUB_LEGACY_AGENTS.includes(a.agent)), [snapshot])
  const project = projectId || sessionProject || snapshot?.projects[0]?.id || ''
  /* Default to the first installed CLI that supports the chosen mode. */
  const usable = adapters.filter(a => a.available && a.modes.includes(mode === 'managed' ? 'managed' : 'terminal'))
  const chosen = agent && usable.some(a => a.agent === agent) ? agent : usable[0]?.agent ?? ''
  /* Main working tree: whether it is a git repository and how many uncommitted changes would be carried along. */
  const [tree, setTree] = useState<{ project: string; git: boolean; changed: number } | null>(null)
  const [carry, setCarry] = useState(true)
  useEffect(() => {
    if (!project) return
    let alive = true
    const read = () => window.yan.hub.command({ action: 'workspace-status', projectId: project })
      .then(r => { if (alive) setTree({ project, ...(r as { git: boolean; changed: number }) }) }).catch(() => { if (alive) setTree(null) })
    void read()
    const timer = setInterval(read, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [project])
  const state = tree?.project === project ? tree : null
  const notGit = state?.git === false
  const carrying = carry && !!state?.git && state.changed > 0
  const attach = useAttachments()
  const readonlyBlocked = mode === 'readonly' && project !== sessionProject
  const canSubmit = !busy && !!project && (mode === 'readonly' || !!chosen) && (mode === 'terminal' || !!prompt.trim() || attach.items.length > 0) && !readonlyBlocked && !(mode === 'managed' && notGit)

  /* Installs run in an ordinary visible terminal; when that terminal exits the CLIs are detected again. */
  const terminals = useStore(s => s.terminals)
  const [installs, setInstalls] = useState<Record<string, string>>({})
  const [detecting, setDetecting] = useState(false)
  const detect = async () => {
    setDetecting(true)
    try { await window.yan.hub.detect(); await onRefresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setDetecting(false) }
  }
  useEffect(() => {
    const done = Object.entries(installs).filter(([, id]) => !terminals.some(term => term.id === id && term.alive))
    if (!done.length) return
    setInstalls(old => Object.fromEntries(Object.entries(old).filter(([agent]) => !done.some(([d]) => d === agent))))
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminals])
  const install = async (cli: Exclude<HubAgent, 'pi'>) => {
    setError('')
    const terminal = await useStore.getState().startTerminal({ cols: 100, rows: 24 })
    if (!terminal) { setError(t('hub.err.terminal')); return }
    /* Give the shell a moment to start reading input before the command is typed. */
    await new Promise(resolve => setTimeout(resolve, 600))
    await window.yan.terminal.write(terminal.id, `npm install -g ${HUB_CLI_PACKAGES[cli]}\r`)
    setInstalls(old => ({ ...old, [cli]: terminal.id }))
  }

  const createHub = async (request: { agent: HubAgent; mode: 'terminal' | 'managed'; prompt: string }, attachments?: HubAttachmentInput[]) => {
    const full = { ...request, projectId: project, parentSessionId: sessionProject === project ? sessionId : undefined, includeWorkingChanges: carrying }
    const signature = JSON.stringify({ ...full, files: attachments?.map(a => a.name + a.data.length) })
    /* Retrying the same request reuses its id so the host can de-duplicate it. */
    if (createId.current?.signature !== signature) createId.current = { id: crypto.randomUUID(), signature }
    const result = await window.yan.hub.command({ action: 'create', request: { ...full, attachments, requestId: createId.current.id } }) as { taskId: string }
    createId.current = undefined
    await onRefresh(); onOpenRun(`hub:${result.taskId}`)
  }
  const openTerminal = async (cli: HubAgent) => {
    setBusy(true); setError('')
    try { await createHub({ agent: cli, mode: 'terminal', prompt: '' }) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const create = async () => {
    setBusy(true); setError('')
    try {
      if (mode === 'readonly') {
        const result = await window.yan.subagents.start(prompt, undefined, 'controlled-cwd')
        if (!result.ok || !result.run) throw new Error(result.error || t('hub.err.readonly'))
        await loadSubagents(); onOpenRun(`subagent:${result.run.id}`)
      } else await createHub({ agent: chosen as HubAgent, mode, prompt }, attach.inputs())
      setPrompt(''); attach.clear()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  /* 关闭记录只隐藏提醒：成果、报告和工作区保留，不验收。 */
  const closeRuns = async (list: AgentWorkspaceRun[]) => {
    setBusy(true); setError('')
    try {
      for (const run of list) if (run.closable && run.source === 'hub') await window.yan.hub.command({ action: 'dismiss', taskId: run.id })
      await onRefresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  /* 进行中与需要处理合成一张表；已结束的折叠在一行后面，想看再展开。 */
  const active = runs.filter(r => r.live || r.attention)
  const ended = runs.filter(r => !r.live && !r.attention)
  const [showEnded, setShowEnded] = useState(false)

  const runRow = (run: AgentWorkspaceRun) => <div key={run.key} className="agent-run-line">
    <button type="button" className="ui-list-row agent-run-row" data-testid={`agent-run-${run.key}`} onClick={() => onOpenRun(run.key)}
      title={`${run.title} · ${agentStatusLabel(t, run.status)}`}>
      <AgentMark agent={run.agent} size={16} />
      <span className="agent-run-text">
        <span className="agent-run-title">{run.title || t('hub.untitled')}</span>
        <span className="agent-run-meta">{[agentName(run.agent), run.source === 'subagent' ? t('hub.kind.subtask') : run.terminal ? '' : t('hub.kind.managed'), ago(t, run.startedAt)].filter(Boolean).join(' · ')}</span>
      </span>
      <span className={`agent-run-status ui-status ${statusTone(run)}`}><i className="ui-status-dot" />{agentStatusLabel(t, run.status)}</span>
    </button>
    {run.closable ? <IconButton size="sm" icon="close" label={t('hub.closeRecord')} disabled={busy} onClick={() => void closeRuns([run])} data-testid={`agent-close-${run.key}`} /> : null}
  </div>

  return <section className="agent-home" data-testid="agent-workspace">
    <div className="agent-home-head">
      <Select aria-label={t('hub.project')} value={project} onChange={e => setProjectId(e.target.value)} data-testid="agent-project">
        {snapshot?.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === sessionProject ? t('hub.currentSessionSuffix') : ''}</option>)}
      </Select>
      <IconButton size="sm" icon="refresh" label={detecting ? t('hub.detecting') : t('hub.redetect')} disabled={detecting} onClick={() => void detect()} data-testid="agent-detect" />
    </div>
    {notGit ? <p className="agent-tree warn" data-testid="agent-tree">{t('hub.notGit')}</p>
      : state && state.changed > 0 ? <div className="agent-tree" data-testid="agent-tree">
        <span className="agent-tree-text">{t('hub.treeChangedLead')}<b>{state.changed}</b>{carry ? t('hub.treeCarry') : t('hub.treeNoCarry')}</span>
        <Switch label={t('hub.carry')} checked={carry} onChange={setCarry} testId="agent-carry" />
      </div> : null}
    <div className="agent-cli ui-card" data-testid="agent-cli">
      <div className="agent-cli-chips">
        {adapters.length ? adapters.map(a => {
          const cli = a.agent as Exclude<HubAgent, 'pi'>
          const installing = !!installs[cli]
          return a.available
            ? <Button key={a.agent} size="sm" disabled={busy || !project} title={`${agentName(a.agent)} ${a.version ?? ''} · ${t('hub.openTerminalHint')}`} onClick={() => void openTerminal(a.agent)} data-testid={`agent-open-${a.agent}`}><span className="agent-chip-body"><AgentMark agent={a.agent} size={14} />{agentName(a.agent)}</span></Button>
            : HUB_CLI_PACKAGES[cli]
              ? <Button key={a.agent} size="sm" variant="ghost" icon="plus" disabled={installing} title={`${t('hub.notInstalled')} · npm install -g ${HUB_CLI_PACKAGES[cli]}`} onClick={() => void install(cli)} data-testid={`agent-install-${a.agent}`}>{installing ? t('hub.installing') : t('hub.install', { name: agentName(a.agent) })}</Button> : null
        }) : <span className="agent-new-hint">{snapshot ? t('hub.noCli') : t('hub.detectingCli')}</span>}
      </div>
      {adapters.some(a => !a.available && !HUB_CLI_PACKAGES[a.agent as Exclude<HubAgent, 'pi'>] && HUB_CLI_INSTALL_URL[a.agent]) ? <p className="agent-new-hint">{t('hub.antigravityMissing', { url: HUB_CLI_INSTALL_URL.antigravity ?? '' })}</p> : null}
      <Button size="sm" variant="ghost" icon="chevron-right" aria-expanded={taskOpen} onClick={() => setTaskOpen(!taskOpen)} data-testid="agent-task-toggle">{taskOpen ? t('hub.collapse') : t('hub.startWithTask')}</Button>
    </div>
    {taskOpen ? <form className="agent-new ui-card" data-testid="agent-new" onSubmit={e => { e.preventDefault(); if (canSubmit) void create() }}>
      <Segmented<Mode> size="sm" label={t('hub.mode')} value={mode} onChange={setMode} testId="agent-mode" options={[
        { value: 'terminal', label: t('hub.mode.terminal'), icon: 'terminal' },
        { value: 'managed', label: t('hub.mode.managed'), icon: 'agent' },
        { value: 'readonly', label: t('hub.mode.readonly'), icon: 'search' }
      ]} />
      {mode !== 'readonly' ? <div className="agent-choices" role="radiogroup" aria-label="Agent">
        {adapters.filter(a => a.available).map(a => {
          const supported = a.modes.includes(mode === 'managed' ? 'managed' : 'terminal')
          return <button key={a.agent} type="button" role="radio" aria-checked={chosen === a.agent} disabled={!supported}
            className={`ui-choice ${chosen === a.agent ? 'sel' : ''}`} data-testid={`agent-choice-${a.agent}`}
            onClick={() => setAgent(a.agent)}>
            <AgentMark agent={a.agent} size={14} />
            <span>{agentName(a.agent)}</span>
            {!supported ? <small>{t('hub.unsupported')}</small> : null}
          </button>
        })}
      </div> : null}
      <AttachmentTray state={attach} />
      <Textarea aria-label={t('hub.prompt')} rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} data-testid="agent-prompt"
        onPaste={attach.onPaste} onDrop={attach.onDrop} onDragOver={e => e.preventDefault()}
        placeholder={mode === 'terminal' ? t('hub.prompt.terminal') : t('hub.prompt.task')}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSubmit) { e.preventDefault(); void create() } }} />
      {error ? <p className="agent-new-error" role="alert">{error}</p> : null}
      <div className="agent-new-foot">
        {mode !== 'readonly' ? <AttachmentPicker state={attach} disabled={busy} /> : null}
        <span className="agent-new-hint">{readonlyBlocked ? t('hub.readonlyBlocked') : mode === 'managed' && notGit ? t('hub.managedNeedsGit') : t(MODE_HINT[mode])}</span>
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} data-testid="agent-submit">{busy ? t('hub.starting') : mode === 'terminal' ? t('hub.openTerminal') : t('hub.dispatch')}</Button>
      </div>
    </form> : error ? <p className="agent-new-error" role="alert">{error}</p> : null}

    {runs.length ? <div className="agent-list">
      {active.map(runRow)}
      {ended.length ? <button type="button" className="agent-ended-toggle" aria-expanded={showEnded} onClick={() => setShowEnded(!showEnded)} data-testid="agent-ended-toggle">
        <span>{t('hub.ended', { n: ended.length })}</span>
        <span className="agent-ended-toggle-end">{showEnded ? t('hub.collapse') : t('hub.expand')}</span>
      </button> : null}
      {showEnded ? ended.map(runRow) : null}
    </div> : <EmptyState icon="agent" title={t('hub.empty.title')}>{t('hub.empty.body')}</EmptyState>
}
  </section>
}
