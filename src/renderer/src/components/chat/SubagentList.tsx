import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { formatDuration } from '../../../../shared/duration'
import { selectSubagentRuns } from '../../state/subagent-view'
import { ThinkingOrbIndicator } from './ThinkingOrbIndicator'

type SubagentFilter = 'all' | 'running' | 'review' | 'ended'

/**
 * 子代理运行列表（实施-11 H-10a）。
 *
 * 位置：右侧工作区工具页 —— 独立子任务是跨回合的后台资源，不固定占据主对话。
 * 数据：只显示**明确归属当前会话**的任务（`selectSubagentRuns`）；挂回助手回合的
 * 模型子代理仍由 TurnView 就地显示，同一 run 不会出现两份列表/两份详情。
 * 详情由右侧工作台资源标签 `subagent:<runId>` 承载（见 RightPanel），本组件只列表。
 *
 * ⚠️ 关闭详情**不**停止任务：停止是明确的按钮。
 */
export function SubagentList({ placement = 'main' }: { placement?: 'main' | 'right' }) {
  const t = useT()
  const runs = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const openSubagent = useStore((s) => s.openSubagent)
  const stopSubagent = useStore((s) => s.stopSubagent)
  const clearSubagents = useStore((s) => s.clearSubagents)
  const loadSubagents = useStore((s) => s.loadSubagents)
  const [filter, setFilter] = useState<SubagentFilter>('all')
  const [now, setNow] = useState(() => Date.now())

  /* 挂载时拉一次（重开应用后能看到本进程里仍在跑的） */
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])

  const groups = useMemo(
    () => selectSubagentRuns(runs, { sessionIds: [session?.sessionId, session?.conversationId].filter((x): x is string => !!x) }),
    [runs, session?.sessionId, session?.conversationId]
  )

  const running = groups.running
  const reviewPending = groups.all.filter((r) => r.review === 'pending' || r.review === 'conflict').length
  const ended = groups.all.length - running

  /* 没有新事件时也要让耗时继续走，避免用户误以为子代理卡住。 */
  useEffect(() => {
    if (running === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  /** 运行中在前，其余按结束时间倒序 —— 键盘浏览时不因排序更新跳焦点 */
  const ordered = useMemo(() => {
    const list = [...groups.detached]
    list.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'starting'
      const bRunning = b.status === 'running' || b.status === 'starting'
      if (aRunning !== bRunning) return aRunning ? -1 : 1
      return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
    })
    return list
  }, [groups.detached])

  const visible = ordered.filter((run) => {
    if (filter === 'running') return run.status === 'running' || run.status === 'starting'
    if (filter === 'review') return run.review === 'pending' || run.review === 'conflict'
    if (filter === 'ended') return run.status !== 'running' && run.status !== 'starting'
    return true
  })

  return (
    <div className={`subagent-zone subagent-zone-${placement}`} data-testid={`subagent-zone-${placement}`}>
      <SubagentLauncher activeCount={running} />
      {groups.detached.length > 0 ? (
        <div className="sa-strip" data-testid="subagent-strip">
          <div className="sa-head">
            <Icon name="layers" size={12} />
            <span className="sa-title">{t('sa.title', { active: running, done: ended })}</span>
            <span className="spacer" />
            {ended > 0 ? (
              <button className="sa-act-btn" onClick={() => void clearSubagents()} data-testid="subagent-clear">
                {t('sa.clear')}
              </button>
            ) : null}
          </div>

          <div className="sa-filters" role="tablist" aria-label={t('sa.section')}>
            {([
              ['all', t('sa.filterAll')],
              ['running', t('sa.filterRunning')],
              ['review', t('sa.filterReview')],
              ['ended', t('sa.filterEnded')]
            ] as [SubagentFilter, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={`sa-filter ${filter === id ? 'on' : ''}`}
                data-testid={`subagent-filter-${id}`}
                onClick={() => setFilter(id)}
              >
                {label}
                {id === 'running' && running > 0 ? <span className="sa-filter-n">{running}</span> : null}
                {id === 'review' && reviewPending > 0 ? <span className="sa-filter-n">{reviewPending}</span> : null}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="sa-empty" data-testid="subagent-empty">
              {t('sa.emptyFilter')}
            </div>
          ) : null}

          {visible.map((run) => {
            const isRunning = run.status === 'running' || run.status === 'starting'
            const reviewState = run.review === 'pending' || run.review === 'conflict'
            return (
              <div key={run.id} className={`sa-row ${run.status}`} data-testid={`subagent-${run.id}`} data-run-id={run.id}>
                <span className="sa-ico" aria-hidden>
                  {isRunning ? <ThinkingOrbIndicator state="working" /> : run.status === 'done' ? '✓' : '✕'}
                </span>
                <span className="sa-task" title={run.task}>
                  {run.task}
                </span>
                <span className="sa-activity" title={run.latestActivity}>
                  {isRunning ? run.latestActivity || t('sa.waiting') : run.status === 'done' ? t('sa.done') : run.error ?? t('sa.stopped')}
                </span>
                {reviewState ? <span className="sa-badge review" data-testid={`subagent-review-badge-${run.id}`}>{t('sa.reviewPending')}</span> : null}
                <span className="sa-time">{duration(run, now)}</span>
                <button className="sa-act-btn" onClick={() => openSubagent(run.id)} data-testid={`subagent-view-${run.id}`}>
                  {t('sa.view')}
                </button>
                {isRunning ? (
                  <button className="sa-act-btn danger" onClick={() => void stopSubagent(run.id)} data-testid={`subagent-stop-${run.id}`}>
                    {t('sa.stop')}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** 已运行时长（秒 / 分）—— 与回合页脚共用 `formatDuration`，不再各写一份。 */
function duration(run: { startedAt: number; endedAt?: number }, now: number): string {
  return formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
}

/**
 * 独立子代理的显式调用入口。
 *
 * `/subagent` 仍然保留给熟悉命令的用户；这个入口解决的是“能力存在但
 * 用户必须记住一条隐藏命令”的发现性问题。启动成功后由 RightPanel 打开
 * 对应的资源标签详情。
 */
function SubagentLauncher({ activeCount }: { activeCount: number }) {
  const t = useT()
  const startSubagent = useStore((s) => s.startSubagent)
  const [open, setOpen] = useState(false)
  const [task, setTask] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    const text = task.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      await startSubagent(text, undefined, readOnly ? 'controlled-cwd' : 'worktree')
      setTask('')
      setReadOnly(false)
      setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="sa-launcher">
      <div className="sa-launch-row">
        <div className="sa-launch-label">
          <Icon name="layers" size={12} />
          <span>{t('sa.section')}</span>
          <span className="sa-launch-caption">{t('sa.workspace')}</span>
        </div>
        <button
          className="sa-launch-btn"
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="subagent-launch-panel"
          data-testid="subagent-new"
          title={t('sa.newTip')}
        >
          <Icon name="layers" size={12} />
          <span>{t('sa.new')}</span>
          {activeCount > 0 ? <span className="sa-launch-count">{activeCount}</span> : null}
        </button>
      </div>

      {open ? (
        <div className="sa-launch-panel" id="subagent-launch-panel" data-testid="subagent-launch-panel">
          <div className="sa-launch-title">{t('sa.newTitle')}</div>
          <textarea
            value={task}
            rows={3}
            autoFocus
            placeholder={t('sa.taskPlaceholder')}
            data-testid="subagent-task"
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <label className="sa-readonly-label">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(event) => setReadOnly(event.target.checked)}
              data-testid="subagent-readonly"
            />
            <span>{t('sa.readOnlyMode')}</span>
          </label>
          <div className="sa-launch-actions">
            <span className="sa-launch-hint">{t('sa.newHint')}</span>
            <button className="sa-act-btn" type="button" onClick={() => setOpen(false)}>
              {t('sa.cancel')}
            </button>
            <button className="sa-act-btn primary" type="button" disabled={!task.trim() || submitting} onClick={() => void submit()} data-testid="subagent-start">
              {t('sa.start')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
