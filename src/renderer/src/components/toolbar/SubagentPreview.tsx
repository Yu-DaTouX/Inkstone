import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { formatDuration } from '../../../../shared/duration'
import { Markdown } from '../chat/MessageParts'

type SubagentDetailTab = 'overview' | 'process' | 'changes'

/**
 * 子代理详情（实施-11 H-10a）。
 *
 * 由右侧工作台资源标签 `subagent:<runId>` 承载：同一 run 从列表、回合短入口、
 * 通知打开都是同一份。内容拆成三页签：
 *   概览（默认，运行时也能看）/ 过程（转录）/ 变更（diff 与审阅）。
 * **执行状态**（running/done/error/cancelled）与**审阅状态**（pending/conflict/
 * merged/…）是两个字段，不能用一个颜色代替。
 *
 * ⚠️ 关闭详情**不停止**任务；收起右栏也不停止。
 */
export function SubagentPreview({ placement = 'right' }: { placement?: 'main' | 'right' }) {
  const t = useT()
  const id = useStore((s) => s.subagentPreviewId)
  const run = useStore((s) => s.subagents.find((r) => r.id === id) ?? null)
  const close = useStore((s) => s.openSubagent)
  const stop = useStore((s) => s.stopSubagent)
  const merge = useStore((s) => s.mergeSubagent)
  const discard = useStore((s) => s.discardSubagent)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [tab, setTab] = useState<SubagentDetailTab>('overview')
  const [now, setNow] = useState(() => Date.now())

  /* 旧 right placement 占右栏；领自己的 blocker，关闭只释放自己的。 */
  useEffect(() => {
    if (placement !== 'right' || !id) return undefined
    return acquireOverlayBlocker('subagent-preview')
  }, [id, placement, acquireOverlayBlocker])

  /* 切换 run 回到概览，不继承上一个 run 的页签 */
  useEffect(() => {
    setTab('overview')
  }, [id])

  const running = run?.status === 'running' || run?.status === 'starting'

  /* 运行中让耗时继续走 */
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  /* 跟随最新输出（用户上滚时暂停）——只在过程页挂载时生效 */
  const count = run?.transcript.length ?? 0
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [count, tab])

  const lastReply = useMemo(() => {
    const list = run?.transcript ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role === 'assistant' && (m.text ?? '').trim()) return m.text
    }
    return ''
  }, [run?.transcript])

  if (!run) return null

  const execStatus =
    run.status === 'running' || run.status === 'starting'
      ? t('sa.running')
      : run.status === 'done'
        ? t('sa.done')
        : run.status === 'cancelled'
          ? t('sa.stopped')
          : t('sa.failed')

  const reviewLabel =
    run.review === 'pending'
      ? t('sa.reviewPending')
      : run.review === 'conflict'
        ? t('sa.reviewConflict')
        : run.review === 'merged'
          ? t('sa.reviewMerged')
          : run.review === 'discarded'
            ? t('sa.reviewDiscarded')
            : run.review === 'archived'
              ? t('sa.reviewArchived')
              : t('sa.reviewNone')

  const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })

  const tabs: [SubagentDetailTab, string][] = [
    ['overview', t('sa.tabOverview')],
    ['process', t('sa.tabProcess')],
    ['changes', t('sa.tabChanges')]
  ]

  return (
    <div className={`sp ${placement === 'main' ? 'sp-main' : ''}`} data-testid="subagent-preview">
      <div className="sp-head">
        <Icon name="layers" size={12} />
        <span className="sp-title" title={run.task}>
          {run.task}
        </span>
        <span className="spacer" />
        <span className={`sp-state ${run.status}`} data-testid="subagent-exec-state" title={t('sa.execState')}>
          {execStatus}
        </span>
        <button
          className="fp-act"
          onClick={() => close(null)}
          title={t('sa.close')}
          aria-label={t('sa.close')}
          data-testid="subagent-preview-close"
        >
          <Icon name="plus" size={12} className="fp-x" />
        </button>
      </div>

      <div className="sp-meta">
        <span title={run.cwd}>{run.cwd}</span>
        {run.model ? <span>· {run.model}</span> : null}
        <span>· {run.isolation === 'worktree' ? t('sa.isolated') : t('sa.readOnly')}</span>
        {run.error ? <span className="sp-err">· {run.error}</span> : null}
      </div>

      {run.parentSessionId || run.parentRunId ? (
        <div className="sp-meta sp-parent" title={run.parentSessionId ?? run.parentRunId}>
          {t('sa.parent')}: {run.parentSessionId ?? '—'}{run.parentRunId ? ` · ${run.parentRunId}` : ''}
        </div>
      ) : null}

      <div className="sp-tabs" role="tablist" aria-label={t('sa.detailTabs')}>
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`sp-tab ${tab === key ? 'on' : ''}`}
            data-testid={`subagent-tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
            {key === 'changes' && (run.review === 'pending' || run.review === 'conflict') ? (
              <span className="sa-badge review">{reviewLabel}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="sp-overview" data-testid="subagent-overview">
          <div className="sp-ov-row">
            <span className="sp-ov-label">{t('sa.latestActivity')}</span>
            <span className="sp-ov-value">{run.latestActivity || (running ? t('sa.waiting') : t('sa.empty'))}</span>
          </div>
          <div className="sp-ov-row">
            <span className="sp-ov-label">{t('sa.elapsed')}</span>
            <span className="sp-ov-value">{elapsed}</span>
          </div>
          <div className="sp-ov-row">
            <span className="sp-ov-label">{t('sa.reviewState')}</span>
            <span className="sp-ov-value" data-testid="subagent-review-state">{reviewLabel}</span>
          </div>
          {run.usage ? (
            <div className="sp-ov-row" data-testid="subagent-usage">
              <span className="sp-ov-label">{t('sa.usage')}</span>
              <span className="sp-ov-value">
                {t('sa.usageLine', {
                  input: run.usage.input ?? '—',
                  output: run.usage.output ?? '—',
                  cache: run.usage.cacheRead ?? '—'
                })}
              </span>
            </div>
          ) : null}
          {run.diff ? (
            <div className="sp-ov-row">
              <span className="sp-ov-label">{t('sa.diff')}</span>
              <span className="sp-ov-value">
                {t('sa.diffStats', { files: run.diff.files, additions: run.diff.additions, deletions: run.diff.deletions })}
              </span>
            </div>
          ) : null}
          <div className="sp-ov-result">
            <div className="sp-ov-label">{t('sa.result')}</div>
            {lastReply ? (
              <div className="sp-ov-text">
                <Markdown text={lastReply.length > 1200 ? `${lastReply.slice(0, 1200)}…` : lastReply} />
              </div>
            ) : (
              <div className="sp-note">{running ? t('sa.waiting') : t('sa.empty')}</div>
            )}
          </div>
          {run.review === 'pending' || run.review === 'conflict' ? (
            <button className="sa-act-btn" type="button" onClick={() => setTab('changes')} data-testid="subagent-goto-changes">
              {t('sa.viewChanges')}
            </button>
          ) : null}
        </div>
      ) : null}

      {tab === 'process' ? (
        <div
          className="sp-body"
          ref={bodyRef}
          data-testid="subagent-preview-body"
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {run.transcript.length === 0 ? (
            <div className="sp-note">{running ? t('sa.waiting') : t('sa.empty')}</div>
          ) : (
            run.transcript.map((msg) => (
              <div key={msg.id} className={`sp-msg ${msg.role}`}>
                <div className="sp-role">{msg.role === 'user' ? t('chat.you') : t('chat.assistant')}</div>
                {msg.thinking ? <div className="sp-think">{msg.thinking.slice(0, 2000)}</div> : null}
                {msg.text ? <Markdown text={msg.text} /> : null}
                {msg.toolCalls?.length ? (
                  <div className="sp-tools">
                    {msg.toolCalls.map((c) => (
                      <span key={c.id} className="sp-tool" data-state={c.status}>
                        {c.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === 'changes' ? (
        <div className="sp-review" data-testid="subagent-review">
          <div className="sp-review-head">
            <span>{t('sa.diff')}</span>
            {run.diff ? (
              <span>{t('sa.diffStats', { files: run.diff.files, additions: run.diff.additions, deletions: run.diff.deletions })}</span>
            ) : null}
          </div>
          {run.diff ? (
            <>
              {run.diff.paths.length ? (
                <div className="sp-diff-paths" title={run.diff.paths.join('\n')}>
                  {run.diff.paths.slice(0, 6).join(' · ')}{run.diff.truncated ? ' · …' : ''}
                </div>
              ) : (
                <div className="sp-diff-paths">{t('sa.noDiff')}</div>
              )}
              {run.diff.patchPath ? (
                <button
                  className="sa-act-btn"
                  onClick={() => void window.yan.openPath(run.diff!.patchPath!)}
                  data-testid="subagent-diff-open"
                >
                  {t('sa.openDiff')}
                </button>
              ) : null}
            </>
          ) : (
            <div className="sp-note">{t('sa.noDiff')}</div>
          )}
          <div className="sp-review-state" data-testid="subagent-review-state-changes">{reviewLabel}</div>
          {!running && (run.review === 'pending' || run.review === 'conflict') ? (
            <span className="sp-review-actions">
              <button className="sa-act-btn" onClick={() => void merge(run.id)} data-testid="subagent-merge">
                {t('sa.merge')}
              </button>
              <button className="sa-act-btn danger" onClick={() => void discard(run.id)} data-testid="subagent-discard">
                {t('sa.discard')}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      {running ? (
        <div className="sp-foot">
          <button className="btn" onClick={() => void stop(run.id)} data-testid="subagent-preview-stop">
            {t('sa.stop')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
