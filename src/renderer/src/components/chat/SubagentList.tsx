import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { ThinkingOrbIndicator } from './ThinkingOrbIndicator'
import { SubagentDetails } from './SubagentDetails'

/**
 * 子代理运行列表（方案 8.3）。
 *
 * 位置：输入区上方的主对话区域 —— 子任务是「正在发生的事」，
 * 与推理/工具同类，不该塞进右栏的工具分区里（那里是「查看」）。
 *
 * 形态：紧凑一行一条，和工具行同一套读法：
 *   ● 检查附件流程   正在读取 Composer.tsx   18s   [查看] [停止]
 *   ✓ 审阅样式       已完成                        [查看]
 *
 * ⚠️ 关闭预览**不**停止任务（方案 8.3）：停止是明确的按钮。
 */
export function SubagentList() {
  const t = useT()
  const runs = useStore((s) => s.subagents)
  const openSubagent = useStore((s) => s.openSubagent)
  const stopSubagent = useStore((s) => s.stopSubagent)
  const clearSubagents = useStore((s) => s.clearSubagents)
  const loadSubagents = useStore((s) => s.loadSubagents)
  const previewId = useStore((s) => s.subagentPreviewId)
  const [now, setNow] = useState(() => Date.now())

  /* 挂载时拉一次（重开应用后能看到本进程里仍在跑的） */
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])

  const active = runs.filter((r) => r.status === 'running' || r.status === 'starting')
  const finished = runs.length - active.length
  const hasFinished = finished > 0

  /* 没有新事件时也要让耗时继续走，避免用户误以为子代理卡住。 */
  useEffect(() => {
    if (active.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active.length])

  return (
    <div className="subagent-zone">
      <SubagentLauncher activeCount={active.length} />
      {runs.length > 0 ? (
        <div className="sa-strip" data-testid="subagent-strip">
          <div className="sa-head">
            <Icon name="layers" size={12} />
            <span className="sa-title">
              {t('sa.title', { active: active.length, done: finished })}
            </span>
            <span className="spacer" />
            {hasFinished ? (
              <button className="sa-act-btn" onClick={() => void clearSubagents()} data-testid="subagent-clear">
                {t('sa.clear')}
              </button>
            ) : null}
          </div>

          {runs.map((run) => {
            const running = run.status === 'running' || run.status === 'starting'
            return (
              <div key={run.id} className={`sa-row ${run.status}`} data-testid={`subagent-${run.id}`}>
                <span className="sa-ico" aria-hidden>
                  {running ? <ThinkingOrbIndicator state="working" /> : run.status === 'done' ? '✓' : '✕'}
                </span>
                <span className="sa-task" title={run.task}>
                  {run.task}
                </span>
                <span className="sa-activity" title={run.latestActivity}>
                  {running ? run.latestActivity || t('sa.waiting') : run.status === 'done' ? t('sa.done') : run.error ?? t('sa.stopped')}
                </span>
                <span className="sa-time">{duration(run, now)}</span>
                <button
                  className="sa-act-btn"
                  onClick={() => openSubagent(run.id)}
                  data-testid={`subagent-view-${run.id}`}
                >
                  {t('sa.view')}
                </button>
                {running ? (
                  <button
                    className="sa-act-btn danger"
                    onClick={() => void stopSubagent(run.id)}
                    data-testid={`subagent-stop-${run.id}`}
                  >
                    {t('sa.stop')}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {previewId ? <SubagentDetails placement="main" /> : null}
    </div>
  )
}

/** 已运行时长（秒 / 分） */
function duration(run: { startedAt: number; endedAt?: number }, now: number): string {
  const ms = (run.endedAt ?? now) - run.startedAt
  const secs = Math.max(1, Math.round(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m${secs % 60}s`
}

/**
 * 输入区上方的显式调用入口，位置与任务进度条相邻。
 *
 * `/subagent` 仍然保留给熟悉命令的用户；这个入口解决的是“能力存在但
 * 用户必须记住一条隐藏命令”的发现性问题。启动后的同一条 run 会立即
 * 进入列表，并默认打开主工作区里的实时详情。
 */
function SubagentLauncher({ activeCount }: { activeCount: number }) {
  const t = useT()
  const startSubagent = useStore((s) => s.startSubagent)
  const [open, setOpen] = useState(false)
  const [task, setTask] = useState('')
  const [readOnly, setReadOnly] = useState(false)

  const submit = async (): Promise<void> => {
    const text = task.trim()
    if (!text) return
    await startSubagent(text, undefined, readOnly ? 'controlled-cwd' : 'worktree')
    setTask('')
    setReadOnly(false)
    setOpen(false)
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
            <button className="sa-act-btn primary" type="button" disabled={!task.trim()} onClick={() => void submit()} data-testid="subagent-start">
              {t('sa.start')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
