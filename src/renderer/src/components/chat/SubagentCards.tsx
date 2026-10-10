import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import type { SubagentRun, UIMessage } from '../../../../shared/ipc'
import { formatDuration } from '../../../../shared/duration'
import { subagentOutcome, type SubagentOutcome } from '../../../../shared/subagent-outcome'
import { useStore } from '../../state/store'
import { Button } from '../ui'

/** 详情里最多列多少条工具调用 */
const DETAIL_LIMIT = 6

export const isLive = (run: SubagentRun): boolean => run.status === 'starting' || run.status === 'running'

/** `provider/id` → `id`：提供商名太长且不影响辨认模型，完整写法留在详情里 */
function shortModel(model: string): string {
  const i = model.indexOf('/')
  return i >= 0 ? model.slice(i + 1) : model
}

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

/** 状态图标：一个字符足以在灰底上分出「在跑 / 好了 / 要看 / 出错 / 已停」 */
const MARK: Record<SubagentOutcome['tone'], string> = { live: '', ok: '✓', warn: '!', err: '✕', mute: '■' }

/** 秒表：只在有运行中的子代理时每秒走一次 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * 一组子代理（同一条助手消息触发的，或没有可挂靠消息的）。
 *
 * 按启动顺序保持位置稳定；运行与需要处理的状态由图标和文字表达。
 */
export function SubagentGroup({ runs, showTag = true }: { runs: SubagentRun[]; showTag?: boolean }) {
  const now = useNow(runs.some(isLive))
  if (!runs.length) return null
  const ranked = runs
    .map((run) => ({ run, outcome: subagentOutcome(run) }))
    .sort((a, b) => a.run.startedAt - b.run.startedAt)
  return (
    <div className="sg-group" data-testid="subagent-group">
      {ranked.map(({ run, outcome }) => (
        <SubagentCard key={run.id} run={run} outcome={outcome} now={now} showTag={showTag} />
      ))}
    </div>
  )
}

/**
 * 一张子代理卡片，信息分三层：
 *   ① 状态图标 + 任务（主）+ 状态词与耗时（右）
 *   ② 灰色小字一行：子代理 · 范围 · 模型简称 · 耗时
 *   ③ 至多一行当前动作或原因；完整任务、最近工具和产出按需展开。
 * 待审阅的改动保留操作入口，默认不把过程正文铺进聊天。
 */
function SubagentCard({ run, outcome, now, showTag }: { run: SubagentRun; outcome: SubagentOutcome; now: number; showTag: boolean }) {
  const t = useT()
  const stopSubagent = useStore((s) => s.stopSubagent)
  const mergeSubagent = useStore((s) => s.mergeSubagent)
  const discardSubagent = useStore((s) => s.discardSubagent)
  const [expanded, setExpanded] = useState(false)
  const { live, attention, tone } = outcome
  const readOnly = run.isolation === 'controlled-cwd'
  const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
  const calls = run.toolCalls ?? run.transcript.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0)
  const changed = run.diff && run.diff.files > 0 ? run.diff : null
  const reviewing = !live && (run.review === 'pending' || run.review === 'conflict')

  /* 默认只给原因；产出正文留在详情中。 */
  const reason =
    outcome.partial && run.status === 'done'
      ? t(run.endReason === 'budget' ? 'sa.partialBudget' : 'sa.partialTimeout')
      : run.status === 'error'
        ? run.error
        : ''

  const meta: { key: string; node: React.ReactNode }[] = [
    ...(showTag ? [{ key: 'tag', node: <span data-testid={`subagent-note-tag-${run.id}`}>{t('sa.tag')}</span> }] : []),
    {
      key: 'mode',
      node: (
        <span className={readOnly ? 'ro' : 'rw'} data-testid={`subagent-note-mode-${run.id}`} title={readOnly ? t('sa.readOnlyHint') : t('sa.writesHint')}>
          {readOnly ? t('sa.readOnly') : t('sa.writes')}
        </span>
      )
    },
    {
      key: 'model',
      node: (
        <span className="sg-model" data-testid={`subagent-note-model-${run.id}`} title={run.model ?? ''}>
          {run.model ? shortModel(run.model) : t('sa.modelDefault')}
        </span>
      )
    }
  ]
  meta.push({ key: 'elapsed', node: <span className="sg-time">{elapsed}</span> })
  const openRun = () => window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${run.id}` }))

  return (
    <div className={`sg-card tone-${tone}${attention ? ' is-attn' : ''}${live ? ' is-live' : ''}`} data-testid={`subagent-note-${run.id}`} data-outcome={outcome.key}>
      <div className="sg-main">
        <span className="sg-mark" aria-hidden="true">
          {MARK[tone]}
        </span>
        <button
          type="button"
          className="sg-task"
          title={run.task}
          onClick={openRun}
          data-testid={`subagent-note-toggle-${run.id}`}
        >
          {run.task.split('\n')[0].slice(0, 64)}
        </button>
        <span className="sg-state" data-testid={`subagent-note-state-${run.id}`}>
          {t(`sa.state.${outcome.key}` as MessageKey)}
        </span>
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{t('sa.noteDetails')}</Button>
        {live ? <Button variant="danger" size="sm" onClick={() => void stopSubagent(run.id)} data-testid={`subagent-note-stop-${run.id}`}>{t('sa.stop')}</Button> : null}
      </div>
      <div className="sg-meta">
        {meta.map((item) => (
          <span key={item.key} className="sg-meta-item">
            {item.node}
          </span>
        ))}
      </div>
      {live && (run.progressWarning || run.latestActivity) ? (
        <div className={`sg-line sg-activity${run.progressWarning ? ' sg-reason' : ''}`} title={run.progressWarning || run.latestActivity} data-testid={`subagent-note-activity-${run.id}`}>
          {run.progressWarning || run.latestActivity}
        </div>
      ) : null}
      {!live && reason ? (
        <div className={`sg-line sg-reason${expanded ? '' : ' sg-activity'}`} title={reason} data-testid={`subagent-note-reason-${run.id}`}>
          {reason}
        </div>
      ) : null}
      {reviewing ? (
        <div className="sg-actions">
          {run.diff?.patchPath ? (
            <Button size="sm" onClick={() => void window.yan.openPath(run.diff!.patchPath!)} data-testid={`subagent-note-diff-${run.id}`}>
              {t('sa.openDiff')}
            </Button>
          ) : null}
          {live ? (
            <Button variant="danger" size="sm" onClick={() => void stopSubagent(run.id)} data-testid={`subagent-note-stop-${run.id}`}>
              {t('sa.stop')}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => void mergeSubagent(run.id)} data-testid={`subagent-note-merge-${run.id}`}>
                {t('sa.merge')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => void discardSubagent(run.id)} data-testid={`subagent-note-discard-${run.id}`}>
                {t('sa.discard')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {expanded ? <><div className="sg-line">{run.task}</div><div className="sg-meta">{run.model}{run.thinkingLevel ? <span data-testid={`subagent-note-thinking-${run.id}`}> · {t('sa.thinking', { level: run.thinkingLevel })}</span> : null} · {t('sa.toolUses', { count: calls })}{run.usage?.output ? ` · ${t('sa.outputTokens', { count: compactTokens(run.usage.output) })}` : ''}{changed ? ` · ${t('sa.diffStats', { files: changed.files, additions: changed.additions, deletions: changed.deletions })}` : ''}</div><SubagentDetail run={run} /></> : null}
    </div>
  )
}

/**
 * 详情：最近几步工具调用 + 最终回复。
 * 完整任务和模型用量由明确的详情入口展示；这里补充最近工具与回复。
 */
function SubagentDetail({ run }: { run: SubagentRun }) {
  const t = useT()
  const calls = run.transcript.flatMap((m: UIMessage) => m.toolCalls ?? [])
  const shown = calls.slice(-DETAIL_LIMIT)
  const lastText = [...run.transcript].reverse().find((m) => m.role === 'assistant' && m.text.trim())?.text.trim()
  return (
    <div className="sg-detail" data-testid={`subagent-detail-${run.id}`}>
      {shown.length ? (
        <div className="sg-d-tools">
          {calls.length > shown.length ? <div className="sg-d-dim">{t('sa.stepsMore', { n: calls.length - shown.length })}</div> : null}
          {shown.map((c) => (
            <div className={`sg-d-tool ${c.status}`} key={c.id}>
              <span className="sg-d-tool-name">{c.name}</span>
              <span className="sg-d-tool-args">{toolArgSummary(c.args)}</span>
              <span className="sg-d-tool-status">{c.status === 'ok' ? '✓' : c.status === 'error' ? '✗' : '…'}</span>
            </div>
          ))}
        </div>
      ) : null}
      {lastText ? <div className="sg-d-text">{lastText}</div> : <div className="sg-d-dim">{t('sa.emptyTranscript')}</div>}
    </div>
  )
}

function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const first = Object.values(args as Record<string, unknown>).find((v) => typeof v === 'string') as string | undefined
  return first ? first.replace(/\s+/g, ' ').slice(0, 100) : ''
}
