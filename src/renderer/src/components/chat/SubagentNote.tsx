import { useEffect } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { selectSubagentRuns } from '../../state/subagent-view'
import type { SubagentRun } from '../../../../shared/ipc'

/** 刚结束的子代理在会话流里保留多久（过后自动退场） */
const RECENT_DONE_MS = 5 * 60_000

/**
 * 子代理在普通会话里的入口（实施-20 U4）。
 *
 * 专用子代理页 / 资源标签 / 新建面板撤下后，agent 自行调用子代理时的
 * **必要**反馈必须还在：运行状态、最新活动、变更摘要，以及必须由人决定的
 * 停止 / 合并 / 放弃。这里把它压成输入框上方的一条非阻塞行（与 HandoffNote 同级）：
 * 不常驻管理页，也不在会话里塞连续重复的伪消息。
 *
 * 已合并 / 已放弃 / 已归档的运行会安静退场 —— 那些不再需要人处理。
 */
export function SubagentNote() {
  const t = useT()
  const runs = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const stopSubagent = useStore((s) => s.stopSubagent)
  const mergeSubagent = useStore((s) => s.mergeSubagent)
  const discardSubagent = useStore((s) => s.discardSubagent)
  const loadSubagents = useStore((s) => s.loadSubagents)

  /* 挂载时拉一次：重开应用后仍能看到本进程里在跑的子代理 */
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])

  const sessionIds = [session?.sessionId, session?.conversationId].filter(
    (value): value is string => !!value
  )
  const groups = selectSubagentRuns(runs, { sessionIds })
  /*
   * 只列**明确归属当前会话**的运行（`all` 已经排除了别的会话与无归属的旧记录）。
   * 再只留还需要人手的：运行中 / 待审阅 / 冲突；已合并、已放弃、已归档安静退场。
   */
  const visible = groups.all.filter((run) => {
    if (run.status === 'starting' || run.status === 'running' || run.status === 'error') return true
    if (run.review === 'pending' || run.review === 'conflict') return true
    /*
     * 刚结束的也压成一条真实摘要（“完成后压为一条真实摘要或收起”）：
     * 既让用户看得到结果，又不会永久占着会话流。
     */
    return run.status === 'done' && !!run.endedAt && Date.now() - run.endedAt < RECENT_DONE_MS
  })
  if (!visible.length) return null

  const stateText = (run: SubagentRun): string => {
    if (run.status === 'running' || run.status === 'starting') return t('sa.running')
    if (run.status === 'error') return t('sa.failed')
    if (run.status === 'cancelled') return t('sa.stopped')
    if (run.review === 'pending') return t('sa.reviewPending')
    if (run.review === 'conflict') return t('sa.reviewConflict')
    return t('sa.done')
  }

  return (
    <div className="sa-notes" aria-live="polite" data-testid="subagent-notes">
      {visible.map((run) => {
        const running = run.status === 'starting' || run.status === 'running'
        return (
          <div className="sa-note" key={run.id} data-testid={`subagent-note-${run.id}`}>
            <span className={`sa-note-dot ${run.status}`} aria-hidden="true" />
            <span className="sa-note-task" title={run.task}>
              {run.task}
            </span>
            <span className="sa-note-state" data-testid={`subagent-note-state-${run.id}`}>
              {stateText(run)}
            </span>
            {run.latestActivity ? (
              <span className="sa-note-activity" title={run.latestActivity}>
                {run.latestActivity}
              </span>
            ) : null}
            {run.diff ? (
              <span className="sa-note-diff">
                {t('sa.diffStats', {
                  files: run.diff.files,
                  additions: run.diff.additions,
                  deletions: run.diff.deletions
                })}
              </span>
            ) : null}
            <span className="spacer" />
            {run.diff?.patchPath ? (
              <button
                className="sa-act-btn"
                onClick={() => void window.yan.openPath(run.diff!.patchPath!)}
                data-testid={`subagent-note-diff-${run.id}`}
              >
                {t('sa.openDiff')}
              </button>
            ) : null}
            {running ? (
              <button
                className="sa-act-btn danger"
                onClick={() => void stopSubagent(run.id)}
                data-testid={`subagent-note-stop-${run.id}`}
              >
                {t('sa.stop')}
              </button>
            ) : null}
            {!running && (run.review === 'pending' || run.review === 'conflict') ? (
              <>
                <button
                  className="sa-act-btn"
                  onClick={() => void mergeSubagent(run.id)}
                  data-testid={`subagent-note-merge-${run.id}`}
                >
                  {t('sa.merge')}
                </button>
                <button
                  className="sa-act-btn danger"
                  onClick={() => void discardSubagent(run.id)}
                  data-testid={`subagent-note-discard-${run.id}`}
                >
                  {t('sa.discard')}
                </button>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
