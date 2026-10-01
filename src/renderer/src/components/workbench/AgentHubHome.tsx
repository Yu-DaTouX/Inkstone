import { useEffect, useMemo, useRef, useState } from 'react'
import { HUB_CLI_PACKAGES, type HubAgent, type HubAttachmentInput, type HubSnapshot } from '../../../../shared/agent-hub'
import type { AgentWorkspaceRun } from '../../../../shared/agent-workspace'
import { useStore } from '../../state/store'
import { Button, EmptyState, IconButton, Segmented, Select, Switch, Textarea } from '../ui'
import { AttachmentPicker, AttachmentTray, useAttachments } from './AgentAttachments'

type Mode = 'terminal' | 'managed' | 'readonly'

export const AGENT_STATUS: Record<string, string> = { queued: '排队中', preparing: '准备中', running: '运行中', waiting_input: '待答复', needs_review: '待审阅', completed: '已验收', failed: '失败', cancelled: '已停止', uncertain: '待核实', starting: '准备中', done: '已结束', error: '失败', stopped: '已停止' }
const AGENT_NAME: Record<string, string> = { pi: 'pi', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', grok: 'Grok' }
const MODE_HINT: Record<Mode, string> = {
  terminal: '在原生终端里启动所选 CLI，初始指令可留空。',
  managed: '在独立工作区执行任务，完成后等你审阅。',
  readonly: '由 pi 在当前会话项目里只读查看并回报。'
}

export function agentName(agent: string): string { return AGENT_NAME[agent] ?? agent }

/** 3 分钟前 / 2 小时前 / 10/1 */
function ago(at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return ''
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function statusTone(run: AgentWorkspaceRun): string {
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
  const sessionId = useStore(s => s.session?.sessionId)
  const loadSubagents = useStore(s => s.loadSubagents)
  const [mode, setMode] = useState<Mode>('terminal')
  const [agent, setAgent] = useState<HubAgent | ''>('')
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const createId = useRef<{ id: string; signature: string } | undefined>(undefined)
  const adapters = useMemo(() => (snapshot?.adapters ?? []).filter(a => a.agent !== 'pi'), [snapshot])
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
    const done = Object.entries(installs).filter(([, id]) => !terminals.some(t => t.id === id && t.alive))
    if (!done.length) return
    setInstalls(old => Object.fromEntries(Object.entries(old).filter(([agent]) => !done.some(([d]) => d === agent))))
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminals])
  const install = async (cli: Exclude<HubAgent, 'pi'>) => {
    setError('')
    const terminal = await useStore.getState().startTerminal({ cols: 100, rows: 24 })
    if (!terminal) { setError('无法打开终端'); return }
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
        if (!result.ok || !result.run) throw new Error(result.error || '无法启动只读任务')
        await loadSubagents(); onOpenRun(`subagent:${result.run.id}`)
      } else await createHub({ agent: chosen as HubAgent, mode, prompt }, attach.inputs())
      setPrompt(''); attach.clear()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const groups: Array<[string, AgentWorkspaceRun[]]> = [
    ['进行中', runs.filter(r => r.live)],
    ['需要处理', runs.filter(r => !r.live && r.attention)],
    ['已结束', runs.filter(r => !r.live && !r.attention)]
  ]
  const modeLabel = (run: AgentWorkspaceRun) => run.source === 'subagent' ? '子任务' : run.terminal ? '交互终端' : '受管执行'

  return <section className="agent-home" data-testid="agent-workspace">
    <div className="agent-home-head">
      <span className="ui-menu-label">项目</span>
      <Select aria-label="项目" value={project} onChange={e => setProjectId(e.target.value)} data-testid="agent-project">
        {snapshot?.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === sessionProject ? '（当前会话）' : ''}</option>)}
      </Select>
    </div>
    {state ? <div className={`agent-tree ${notGit ? 'warn' : ''}`} data-testid="agent-tree">
      {notGit ? <span>不是 git 仓库：交互终端直接在项目目录运行，不能派受管任务。</span>
        : state.changed > 0 ? <>
          <span className="agent-tree-text">主工作区有 <b>{state.changed}</b> 处未提交改动。Agent 在独立工作区里运行，{carry ? '会带上这些改动作为起点（不算进交付）。' : '将从最近一次提交开始，看不到这些改动。'}</span>
          <Switch label="带上未提交改动" checked={carry} onChange={setCarry} testId="agent-carry" />
        </>
        : <span>主工作区没有未提交改动；Agent 从最近一次提交开始，依赖目录自动链接。</span>}
    </div> : null}
    <div className="agent-cli ui-card" data-testid="agent-cli">
      <div className="agent-cli-head">
        <span className="ui-popover-title">命令行 Agent</span>
        <span className="agent-new-hint">点击直接打开终端</span>
        <IconButton size="sm" icon="refresh" label={detecting ? '正在检测…' : '重新检测已安装的 CLI'} disabled={detecting} onClick={() => void detect()} data-testid="agent-detect" />
      </div>
      {adapters.length ? adapters.map(a => {
        const cli = a.agent as Exclude<HubAgent, 'pi'>
        const installing = !!installs[cli]
        return <div key={a.agent} className="agent-cli-row" data-testid={`agent-cli-${a.agent}`}>
          <span className="ui-letter-mark" aria-hidden>{agentName(a.agent).slice(0, 1)}</span>
          <span className="agent-run-text">
            <span className="agent-run-title">{agentName(a.agent)}</span>
            <span className="agent-run-meta" title={a.available ? a.version : a.error}>{a.available ? (a.version || '已安装') : installing ? '正在安装，终端结束后自动检测' : `未安装 · ${HUB_CLI_PACKAGES[cli] ?? ''}`}</span>
          </span>
          {a.available
            ? <Button size="sm" icon="terminal" disabled={busy || !project} onClick={() => void openTerminal(a.agent)} data-testid={`agent-open-${a.agent}`}>打开终端</Button>
            : HUB_CLI_PACKAGES[cli] ? <Button size="sm" variant="ghost" icon="plus" disabled={installing} title={`在终端中运行 npm install -g ${HUB_CLI_PACKAGES[cli]}`} onClick={() => void install(cli)} data-testid={`agent-install-${a.agent}`}>{installing ? '安装中…' : '安装'}</Button> : null}
        </div>
      }) : <span className="agent-new-hint">{snapshot ? '没有检测到 CLI' : '正在检测已安装的 CLI…'}</span>}
    </div>
    <form className="agent-new ui-card" data-testid="agent-new" onSubmit={e => { e.preventDefault(); if (canSubmit) void create() }}>
      <span className="ui-popover-title">带任务启动</span>
      <Segmented<Mode> size="sm" label="执行方式" value={mode} onChange={setMode} testId="agent-mode" options={[
        { value: 'terminal', label: '交互终端', icon: 'terminal' },
        { value: 'managed', label: '派出子任务', icon: 'agent' },
        { value: 'readonly', label: 'pi 只读', icon: 'search' }
      ]} />
      {mode !== 'readonly' ? <div className="agent-choices" role="radiogroup" aria-label="Agent">
        {adapters.length ? adapters.map(a => {
          const supported = a.modes.includes(mode === 'managed' ? 'managed' : 'terminal')
          const disabled = !a.available || !supported
          return <button key={a.agent} type="button" role="radio" aria-checked={chosen === a.agent} disabled={disabled}
            className={`ui-choice ${chosen === a.agent ? 'sel' : ''}`} data-testid={`agent-choice-${a.agent}`}
            title={a.available ? (a.version ? `${agentName(a.agent)} ${a.version}` : agentName(a.agent)) : a.error || '未安装'}
            onClick={() => setAgent(a.agent)}>
            <span className="ui-letter-mark" aria-hidden>{agentName(a.agent).slice(0, 1)}</span>
            <span>{agentName(a.agent)}</span>
            {!a.available ? <small>未安装</small> : !supported ? <small>不支持</small> : null}
          </button>
        }) : <span className="agent-new-hint">{snapshot ? '没有检测到可用的 CLI' : '正在检测已安装的 CLI…'}</span>}
      </div> : null}
      <AttachmentTray state={attach} />
      <Textarea aria-label="任务内容" rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} data-testid="agent-prompt"
        onPaste={attach.onPaste} onDrop={attach.onDrop} onDragOver={e => e.preventDefault()}
        placeholder={mode === 'terminal' ? '初始指令（可留空）' : '描述要交给 Agent 的任务'}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSubmit) { e.preventDefault(); void create() } }} />
      {error ? <p className="agent-new-error" role="alert">{error}</p> : null}
      <div className="agent-new-foot">
        {mode !== 'readonly' ? <AttachmentPicker state={attach} disabled={busy} /> : null}
        <span className="agent-new-hint">{readonlyBlocked ? '只读任务只能在当前会话的项目里运行' : mode === 'managed' && notGit ? '受管任务需要 git 仓库' : MODE_HINT[mode]}</span>
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} data-testid="agent-submit">{busy ? '启动中…' : mode === 'terminal' ? '打开终端' : '派活'}</Button>
      </div>
    </form>

    {runs.length ? groups.map(([title, list]) => list.length ? <div key={title} className="agent-group">
      <div className="agent-group-title ui-menu-label">{title}<span className="ui-meta-num">{list.length}</span></div>
      {list.map(run => <button key={run.key} type="button" className="ui-list-row agent-run-row" data-testid={`agent-run-${run.key}`} onClick={() => onOpenRun(run.key)}
        title={`${run.title} · ${AGENT_STATUS[run.status] ?? run.status}`}>
        <span className="ui-letter-mark" aria-hidden>{agentName(run.agent).slice(0, 1)}</span>
        <span className="agent-run-text">
          <span className="agent-run-title">{run.title || '未命名任务'}</span>
          <span className="agent-run-meta">{[agentName(run.agent), modeLabel(run), ago(run.startedAt)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className={`agent-run-status ui-status ${statusTone(run)}`}><i className="ui-status-dot" />{AGENT_STATUS[run.status] ?? run.status}</span>
      </button>)}
    </div> : null) : <EmptyState icon="agent" title="还没有协作运行">在上面选择 Agent 打开终端或派出任务；主对话派出的子任务也会出现在这里。</EmptyState>}
  </section>
}
