import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import type { SubagentRun, UIMessage } from '../../../../shared/ipc'
import { formatDuration } from '../../../../shared/duration'
import { subagentOutcome, type SubagentOutcome } from '../../../../shared/subagent-outcome'
import { useStore } from '../../state/store'
import { Button } from '../ui'
import { useConfirm } from '../ui/confirm'

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

/** 结束且无需处理（完成 / 已停止）：可以收起，不再占版面 */
const isQuiet = (outcome: SubagentOutcome): boolean => !outcome.live && !outcome.attention

/**
 * 一组子代理（同一条助手消息触发的，或没有可挂靠消息的）。
 *
 * 按启动顺序保持位置稳定；运行与需要处理的状态由图标和文字表达。
 * 两个及以上时组首一行汇总并行数量，已结束且无需处理的默认收进汇总行。
 */
export function SubagentGroup({ runs }: { runs: SubagentRun[] }) {
  const t = useT()
  const now = useNow(runs.some(isLive))
  const [showQuiet, setShowQuiet] = useState(false)
  if (!runs.length) return null
  const ranked = runs
    .map((run) => ({ run, outcome: subagentOutcome(run) }))
    .sort((a, b) => a.run.startedAt - b.run.startedAt)
  const grouped = ranked.length > 1
  const live = ranked.filter(({ outcome }) => outcome.live).length
  const attention = ranked.filter(({ outcome }) => outcome.attention).length
  const quiet = ranked.length - live - attention
  const shown = grouped && !showQuiet ? ranked.filter(({ outcome }) => !isQuiet(outcome)) : ranked
  return (
    <div className="sg-group" data-testid="subagent-group">
      {grouped ? (
        <div className="sg-head" data-testid="subagent-group-head">
          <span className="sg-head-text">
            {[
              t('sa.group.parallel', { n: ranked.length }),
              live ? t('sa.group.live', { n: live }) : '',
              attention ? t('sa.group.attention', { n: attention }) : '',
              quiet ? t('sa.group.quiet', { n: quiet }) : ''
            ].filter(Boolean).join(' · ')}
          </span>
          {quiet ? (
            <Button size="sm" variant="ghost" aria-expanded={showQuiet} onClick={() => setShowQuiet((v) => !v)} data-testid="subagent-group-toggle">
              {t(showQuiet ? 'sa.group.collapse' : 'sa.group.expand')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {shown.map(({ run, outcome }) => (
        <SubagentCard key={run.id} run={run} outcome={outcome} now={now} />
      ))}
    </div>
  )
}

/**
 * 一张子代理卡片，信息分三层：
 *   ① 状态图标 + 任务（主）+ 状态词与耗时（右）
 *   ② 灰色小字一行：范围 · 模型简称 · 思考强度 · 原生上下文用量 · 耗时
 *   ③ 至多一行当前动作或原因；完整任务、最近工具和产出按需展开。
 * 待审阅的改动保留操作入口，默认不把过程正文铺进聊天。
 */
function SubagentCard({ run, outcome, now }: { run: SubagentRun; outcome: SubagentOutcome; now: number }) {
  const t = useT()
  const stopSubagent = useStore((s) => s.stopSubagent)
  const mergeSubagent = useStore((s) => s.mergeSubagent)
  const discardSubagent = useStore((s) => s.discardSubagent)
  const confirm = useConfirm()
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

  const context = run.contextUsage
  const contextText = context?.tokens != null
    ? `${compactTokens(context.tokens)}${context.contextWindow > 0 ? ` / ${compactTokens(context.contextWindow)}` : ''}${context.percent != null ? ` (${Math.round(context.percent)}%)` : ''}`
    : '—'
  const meta: { key: string; node: React.ReactNode }[] = [
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
          {run.model ? shortModel(run.model) : '—'}
        </span>
      )
    },
    {
      key: 'thinking',
      node: <span data-testid={`subagent-note-thinking-${run.id}`}>{t('sa.thinking', { level: run.thinkingLevel ?? '—' })}</span>
    },
    {
      key: 'context',
      node: <span data-testid={`subagent-note-context-${run.id}`} title={t('sa.contextHint')}>{t('sa.context', { usage: contextText })}</span>
    },
    {
      key: 'elapsed',
      node: <span className="sg-time" data-testid={`subagent-note-time-${run.id}`}>{elapsed}</span>
    }
  ]
  const openRun = () => window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${run.id}` }))
  /* 砚不替子代理自动重来；pi 自带的重试用尽后由用户决定，用同一任务、模型与范围再派一个。 */
  const retry = async () => {
    const result = await window.yan.subagents.start(run.task, run.model, run.isolation)
    if (result.ok) { void useStore.getState().loadSubagents(); window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${result.run?.id}` })) }
  }

  return (
    <div className={`sg-card tone-${tone}${attention ? ' is-attn' : ''}${live ? ' is-live' : ''}${expanded ? ' is-open' : ''}`} data-testid={`subagent-note-${run.id}`} data-outcome={outcome.key}>
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
        <Button size="sm" variant="ghost" className="sg-detail-btn" active={expanded} aria-expanded={expanded} trailingIcon="chevron-right" data-testid={`subagent-note-details-${run.id}`} onClick={() => setExpanded(v => !v)}>{t(expanded ? 'sa.noteHide' : 'sa.noteDetails')}</Button>
        {run.status === 'error' ? <Button size="sm" onClick={() => void retry()} data-testid={`subagent-note-retry-${run.id}`}>{t('sa.retry')}</Button> : null}
        {live ?<Button variant="danger" size="sm" onClick={() => void stopSubagent(run.id)} data-testid={`subagent-note-stop-${run.id}`}>{t('sa.stop')}</Button> : null}
      </div>
      {!isQuiet(outcome) || expanded ? (
        <div className="sg-meta">
          {meta.map((item) => (
            <span key={item.key} className="sg-meta-item">
              {item.node}
            </span>
          ))}
        </div>
      ) : null}
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
          <>
            <Button size="sm" onClick={() => void mergeSubagent(run.id)} data-testid={`subagent-note-merge-${run.id}`}>
              {t('sa.merge')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void (async () => { if (await confirm({ title: t('sa.discardChanges'), body: t('sa.discardConfirm'), detail: run.id, confirmLabel: t('sa.discard'), tone: 'danger' })) void discardSubagent(run.id) })()} data-testid={`subagent-note-discard-${run.id}`}>
              {t('sa.discard')}
            </Button>
          </>
        </div>
      ) : null}
      {expanded ? <><div className="sg-line">{run.task}</div><div className="sg-meta">{run.model} · {t('sa.toolUses', { count: calls })}{run.usage?.output ? ` · ${t('sa.outputTokens', { count: compactTokens(run.usage.output) })}` : ''}{changed ? ` · ${t('sa.diffStats', { files: changed.files, additions: changed.additions, deletions: changed.deletions })}` : ''}</div><SubagentDetail run={run} /></> : null}
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
