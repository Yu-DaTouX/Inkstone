import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { Section } from './ToolSection'
import { useStore } from '../../state/store'
import { RunDot, Button } from '../ui'
import { PresenceList } from '../ui/PresenceList'
import { useConfirm } from '../ui/confirm'
import { visibleSubagentRuns } from '../../state/subagent-view'
import { isLive } from '../chat/SubagentCards'

export function hasTaskTileContent(
  s: Pick<ReturnType<typeof useStore.getState>, 'todos' | 'goal'> & { hasMessageOutputs: boolean; hasSubagents?: boolean }
): boolean {
  return s.todos.length > 0 || !!s.goal?.goalId || !!s.goal?.links?.length || s.hasMessageOutputs || s.hasSubagents === true
}

function SubagentsBlock() {
  const t = useT()
  const confirm = useConfirm()
  const runs = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const clearSubagents = useStore((s) => s.clearSubagents)
  const sessionIds = [session?.sessionId, session?.conversationId].filter((v): v is string => !!v)
  const visible = visibleSubagentRuns(runs, { sessionIds }).sort((a, b) => a.startedAt - b.startedAt)
  if (!visible.length) return null
  const finished = visible.filter((r) => !isLive(r)).length
  const clearFinished = async (): Promise<void> => {
    if (!(await confirm({ title: t('sa.clearFinished'), body: t('sa.clearFinishedConfirm'), detail: String(finished), confirmLabel: t('sa.clearFinished'), tone: 'danger' }))) return
    void clearSubagents()
  }
  return (
    <div className="rp-subagents" data-testid="rp-subagents">
      <div className="rp-sub-head">
        <span>{t('sa.tag')}</span>
        <span className="rp-count">{visible.length - finished}/{visible.length}</span>
        <span className="spacer" />
        {finished > 0 ? (
          <Button size="sm" className="sa-act-btn" onClick={() => void clearFinished()} data-testid="subagent-notes-clear">
            {t('sa.clearFinished')}
          </Button>
        ) : null}
      </div>
      <Button block size="sm" icon="agent" trailingIcon="chevron-right" onClick={() => window.dispatchEvent(new CustomEvent('inkstone-agent-open', {detail:`subagent:${visible[0].id}`}))}>{t('sa.viewInWorkspace')}</Button>
    </div>
  )
}

export function TodoCount() {
  const todos = useStore((s) => s.todos)
  const done = todos.filter((x) => x.done).length
  if (todos.length === 0) return null
  return (
    <span className="rp-count" data-testid="todo-count">
      {done}/{todos.length}
    </span>
  )
}

export function TodoSection() {
  const t = useT()
  const todos = useStore((s) => s.todos)
  const goal = useStore((s) => s.goal)
  const session = useStore((s) => s.session)
  const hasMessageOutputs = useStore((s) => s.messages.some((message) =>
    !!message.artifacts?.length || (message.role === 'user' && !!message.images?.length)
  ))
  const hasSubagents = useStore((s) => visibleSubagentRuns(s.subagents, { sessionIds: [s.session?.sessionId, s.session?.conversationId].filter((v): v is string => !!v) }).length > 0)
  const agentRunning = useStore(
    (s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true
  )
  const history = useStore((s) => s.todoHistory)
  const scrollToTurn = useStore((s) => s.scrollToTurn)
  const [histOpen, setHistOpen] = useState(false)
  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])

  const [open, setOpen] = useState(true)
  const prevTodoCount = useRef(todos.length)
  useEffect(() => {
    if (todos.length > 0 && prevTodoCount.current === 0) setOpen(true)
    prevTodoCount.current = todos.length
  }, [todos.length])
  const allDone = todos.length > 0 && done === todos.length
  const prevAllDone = useRef(allDone)
  useEffect(() => {
    if (allDone && !prevAllDone.current) setOpen(false)
    else if (!allDone && prevAllDone.current) setOpen(true)
    prevAllDone.current = allDone
  }, [allDone])

  const prevDone = useRef<Set<number>>(new Set())
  const [justDone, setJustDone] = useState<Set<number>>(new Set())

  useEffect(() => {
    const cur = new Set(todos.map((x, i) => (x.done ? i : -1)).filter((i) => i >= 0))
    const fresh = new Set<number>()
    for (const i of cur) if (!prevDone.current.has(i)) fresh.add(i)
    prevDone.current = cur
    if (cur.size && fresh.size === cur.size) return
    if (fresh.size === 0) {
      if (justDone.size) setJustDone(new Set())
      return
    }
    setJustDone(fresh)
    const id = setTimeout(() => setJustDone(new Set()), 900)
    return () => clearTimeout(id)
  }, [todos])

  if (todos.length === 0) {
    if (!hasTaskTileContent({ todos, goal, hasMessageOutputs, hasSubagents })) return null
    return <><Section titleKey="rp.todo" testId="rp-todo"><SubagentsBlock /><GoalOutputs /></Section></>
  }

  const pct = todos.length ? (done / todos.length) * 100 : 0
  const activeIdx = (() => {
    const explicit = todos.findIndex((x) => x.status === 'running')
    if (explicit >= 0) return explicit
    if (todos.some((x) => x.status !== undefined)) return -1
    if (!agentRunning) return -1
    return todos.findIndex((x) => !x.done)
  })()
  const active = activeIdx >= 0 ? todos[activeIdx] : null

  return (
    <>

    <Section
      titleKey="rp.todo"
      testId="rp-todo"
      open={open}
      onOpenChange={setOpen}
      extra={
        <span className="rp-count" data-testid="todo-count">
          {done}/{todos.length}
        </span>
      }
    >
      <div className="rp-todo-scroll">
      <div
        className={`rp-meter ${active ? 'busy' : ''}`}
        data-testid="todo-meter"
        data-pct={Math.round(pct)}
        title={t('rp.todoProgress', { done, total: todos.length })}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      {allDone ? (
        <div className="rp-todo-all" data-testid="todo-all-done">
          <span className="rp-all-done">{t('rp.todoAllDone')}</span>
        </div>
      ) : null}

      <div className="rp-todos">
        {todos.map((todo, i) => {
          const isActive = i === activeIdx
          const blocked = todo.status === 'blocked'
          return (
            <div
              key={i}
              className={`rp-todo ${todo.done ? 'done' : blocked ? 'blocked' : 'todo-open'} ${isActive ? 'active' : ''} ${justDone.has(i) ? 'flash' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-done={todo.done ? '1' : '0'}
              data-active={isActive ? '1' : '0'}
              data-blocked={blocked ? '1' : '0'}
              title={todo.text}
            >
              <span className="rp-box" aria-hidden data-testid={isActive ? 'todo-active-label' : undefined}>
                {todo.done ? <Icon name="check" size={12} /> : blocked ? <Icon name="alert-circle" size={12} /> : isActive ? <RunDot /> : null}
              </span>
              <span className="rp-text">{todo.text}</span>
              {blocked ? (
                <span className="rp-state blocked" data-testid="todo-blocked-label">
                  {t('rp.blocked')}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      {history.length > 1 ? (
        <div className="rp-todo-hist" data-testid="todo-history">
          <button
            className={`rp-hist-head ${histOpen ? 'open' : ''}`}
            onClick={() => setHistOpen((v) => !v)}
            aria-expanded={histOpen}
            data-testid="todo-history-toggle"
          >
            <Icon name="history" size={12} className="chev" />
            <span>{t('rp.todoHistory')}</span>
            <span className="spacer" />
            <span className="rp-count">{history.length - 1}</span>
          </button>
          {histOpen ? (
            <div className="rp-hist-body">
              <PresenceList
                items={history.slice(0, -1).reverse()}
                getKey={(snap) => snap.id}
                scope={session?.sessionId ?? session?.conversationId}
              >
                {(snap) => (
                  <div className="rp-hist-item" data-testid={`todo-hist-${snap.round}`}>
                    <div className="rp-hist-meta">
                      <span className="rp-hist-round">
                        {t('rp.todoHistoryRound', { n: snap.round })}
                      </span>
                      <span className="rp-count">
                        {snap.todos.filter((x) => x.done).length}/{snap.todos.length}
                      </span>
                      <span className="spacer" />
                      <button
                        className="rp-hist-jump"
                        onClick={() => scrollToTurn(Math.max(0, snap.round - 1))}
                        data-testid={`todo-hist-jump-${snap.round}`}
                        title={t('rp.todoHistoryJump')}
                      >
                        {t('rp.jump')}
                      </button>
                    </div>
                    <div className="rp-hist-todos">
                      {snap.todos.map((x, j) => (
                        <div key={j} className={`rp-hist-todo ${x.done ? 'done' : ''}`} title={x.text}>
                          <span className="rp-box" aria-hidden>
                            {x.done ? <Icon name="check" size={12} /> : null}
                          </span>
                          <span className="rp-text">{x.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </PresenceList>
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
      <SubagentsBlock />
      <GoalOutputs />
    </Section>
    </>
  )
}

function OutputGroup({
  testId,
  title,
  count,
  children
}: {
  testId: string
  title: string
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className={`rp-output-group ${open ? 'open' : ''}`} data-testid={testId}>
      <button
        type="button"
        className="rp-output-heading"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        <Icon name="chevron-right" size={12} className="chev" />
        <span>{title}</span>
        <span className="rp-count">{count}</span>
      </button>
      {open ? <div className="rp-output-list">{children}</div> : null}
    </section>
  )
}

function GoalOutputs() {
  const t = useT()
  const goalLinks = useStore((s) => s.goal?.links)
  const messages = useStore((s) => s.messages)
  const outputs = useMemo(() => {
    const byPath = new Map<string, { label: string; path: string; unavailable: boolean }>()
    for (const link of goalLinks ?? []) {
      if (link.kind === 'url') continue
      byPath.set(link.target, {
        label: link.label || link.target.split(/[\\/]/).pop() || link.target,
        path: link.target,
        unavailable: link.check?.ok === false
      })
    }
    for (const message of messages) {
      for (const artifact of message.artifacts ?? []) {
        byPath.set(artifact.sourcePath ?? artifact.path, {
          label: artifact.filename,
          path: artifact.sourcePath ?? artifact.path,
          unavailable: artifact.unavailable === true
        })
      }
    }
    return [...byPath.values()]
  }, [goalLinks, messages])
  const urls = useMemo(() => (goalLinks ?? []).filter((link) => link.kind === 'url'), [goalLinks])
  const images = useMemo(() => messages.flatMap((message) =>
    message.role === 'user' ? (message.images ?? []) : []
  ), [messages])

  if (!outputs.length && !urls.length && !images.length) return null
  return (
    <div className="rp-goal-outputs" data-testid="rp-goal-outputs">
      {outputs.length ? (
        <OutputGroup testId="rp-output-products" title={t('goal.outputs')} count={outputs.length}>
          {outputs.slice(-6).map((output) => (
            <button
              type="button"
              className="rp-output-row"
              key={output.path}
              title={output.path}
              disabled={output.unavailable}
              onClick={() => void window.yan.openPath(output.path)}
            >
              <Icon name="folder-open" size={12} />
              <span>{output.label}</span>
              {output.unavailable ? <small>{t('src.unavailable')}</small> : null}
            </button>
          ))}
        </OutputGroup>
      ) : null}
      {urls.length || images.length ? (
        <OutputGroup testId="rp-output-references" title={t('goal.references')} count={urls.length + images.length}>
          {urls.slice(-4).map((link) => (
            <button
              type="button"
              className="rp-output-row"
              key={link.target}
              title={link.target}
              onClick={() => void window.yan.browser.openExternal(link.target)}
            >
              <Icon name="external" size={12} />
              <span>{link.label || link.target}</span>
            </button>
          ))}
          {images.slice(-3).map((image, index) => (
            <div className="rp-output-row" key={`${index}-${image.mimeType}`}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={t('goal.refImage', { n: index + 1 })} />
              <span>{t('goal.refImage', { n: index + 1 })}</span>
            </div>
          ))}
        </OutputGroup>
      ) : null}
    </div>
  )
}
