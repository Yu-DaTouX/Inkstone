import { useEffect } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Spinner } from './Reasoning'

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

  /* 挂载时拉一次（重开应用后能看到本进程里仍在跑的） */
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])

  if (runs.length === 0) return null

  const active = runs.filter((r) => r.status === 'running' || r.status === 'starting')
  const finished = runs.length - active.length
  const hasFinished = finished > 0

  return (
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
              {running ? <Spinner /> : run.status === 'done' ? '✓' : '✕'}
            </span>
            <span className="sa-task" title={run.task}>
              {run.task}
            </span>
            <span className="sa-activity" title={run.latestActivity}>
              {running ? run.latestActivity : run.status === 'done' ? t('sa.done') : run.error ?? t('sa.stopped')}
            </span>
            <span className="sa-time">{duration(run)}</span>
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
  )
}

/** 已运行时长（秒 / 分） */
function duration(run: { startedAt: number; endedAt?: number }): string {
  const ms = (run.endedAt ?? Date.now()) - run.startedAt
  const secs = Math.max(1, Math.round(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m${secs % 60}s`
}
