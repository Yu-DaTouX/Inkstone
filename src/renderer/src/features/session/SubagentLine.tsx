/**
 * 对话里的子 Agent 行（WP-27a）。
 *
 * 消息流里每条子 Agent 只占一行：状态点 · 编号 · 任务 · 状态词 · 用时。
 * 点这一行在右侧打开详情面板（`SubagentPanel`）：结论、错误、改动、审阅、来源与成果、
 * 模型与范围、停止 / 重派 / 分屏看完整转录都在那里，不把细节铺进对话。
 * 同一轮有多条时，行上方加一句汇总（几条、几条在跑）。
 *
 * 状态来源分两层：
 *   · 有正式运行投影（`state/runs-v3.ts`，只有 `agent_settled` 才落终态）时，
 *     以它的阶段为准 —— 编号、模型、状态词都从这里取；
 *   · 没有快照时退回 `state/subagent-view.ts` / `shared/subagent-outcome` 的
 *     既有说法，仍然只按启动时的父会话归属，不冒充当前会话。
 */
import { useEffect, useState, type JSX } from 'react'
import { useI18n, useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3, phaseWord, runTone } from '../../state/runs-v3'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { subagentTileRef } from '../../app/SideBySideLayout'
import { findSubagentSnapshot, subagentLineModel, type SubagentLineModel } from './turn-lines'
import { selectSubagentRuns } from '../../state/subagent-view'
import { sessionViewIdentity } from './view-state'
import { formatDuration } from '../../../../shared/duration'
import type { SubagentOutcomeKey } from '../../../../shared/subagent-outcome'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import type { AssistantTurn } from '../../../../shared/turns'
import { Icon } from './Icon'
import { Busy } from './Busy'
import { useSessionText } from './text'
import { useSubagentPanel } from './subagent-panel-state'

/** 没有运行快照时，`subagent-outcome` 的说法 → 既有 i18n 键。 */
const OUTCOME_KEY: Record<SubagentOutcomeKey, MessageKey> = {
  starting: 'sa.state.starting',
  running: 'sa.state.running',
  wrapUp: 'sa.state.wrapUp',
  done: 'sa.state.done',
  timeout: 'sa.state.timeout',
  budget: 'sa.state.budget',
  failed: 'sa.state.failed',
  stopped: 'sa.state.stopped',
  review: 'sa.state.review',
  conflict: 'sa.state.conflict'
}

/** 行与详情面板共用：按运行快照（没有就按子代理记录）算展示模型，在跑时每秒走表。 */
export function useSubagentView(run: SubagentRun, snapshot?: RunSnapshot): {
  model: SubagentLineModel
  status: string
  dotClass: string
} {
  const t = useT()
  const { lang } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const model = subagentLineModel(run, snapshot, now)

  /* 只有还在跑的才走秒表，历史行不进这里 */
  useEffect(() => {
    if (!model.live) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model.live])

  const status = model.phase ? phaseWord(lang, model.phase) : t(OUTCOME_KEY[model.outcomeKey])
  const dotTone = model.phase ? runTone(model.phase) : model.outcomeTone
  const dotClass = dotTone === 'run' || dotTone === 'live' ? 'run'
    : dotTone === 'ok' || dotTone === 'done' ? 'ok'
      : dotTone === 'err' ? 'err'
        : dotTone === 'ask' || dotTone === 'stall' || dotTone === 'warn' ? 'warn'
          : ''
  return { model, status, dotClass }
}

/**
 * 在并排视图里打开这条子 Agent 的转录。当前视图身份按 peek 成对取值（与
 * `view-state` / `split-view.displayedSessionOf` 同一口径），子 Agent 列放在它旁边；
 * 没有当前视图时 `open` 不做任何事（不凭空开一列）。
 */
export function openSubagentPane(runId: string): void {
  const state = useStore.getState()
  const current = displayedSessionOf({
    peekedSessionId: state.peekedSessionId,
    peekedPath: state.peekedPath,
    session: state.session ? { sessionId: state.session.sessionId, sessionFile: state.session.sessionFile } : null
  })
  useSplitView.getState().open(subagentTileRef(runId), current)
}

export function SubagentLine({ turn }: { turn: AssistantTurn }): JSX.Element | null {
  const tt = useSessionText()
  const subagents = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const runs = useRunsV3((s) => s.runs)

  /* 归属按当前视图（peek 配对）而不是运行实例投影的 session。 */
  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const ids = new Set([turn.id, ...turn.sourceIds])
  const mine = selectSubagentRuns(subagents, { sessionIds }).all.filter(
    (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
  )
  if (!mine.length) return null
  const ordered = [...mine].sort((a, b) => a.startedAt - b.startedAt)
  const live = ordered.filter((run) => run.status === 'running' || run.status === 'starting').length
  return (
    <div className="v3-subagents" data-testid="v3-subagents">
      {ordered.length > 1 ? (
        <div className="v3-subagents-sum" data-testid="v3-subagents-sum">{tt('subagentGroup', { n: ordered.length, live })}</div>
      ) : null}
      {ordered.map((run) => <SubagentRow key={run.id} run={run} owner={view.key} snapshot={findSubagentSnapshot(runs, run.id)} />)}
    </div>
  )
}

function SubagentRow({ run, owner, snapshot }: { run: SubagentRun; owner: string; snapshot?: RunSnapshot }): JSX.Element {
  const tt = useSessionText()
  const { model, status, dotClass } = useSubagentView(run, snapshot)
  const selected = useSubagentPanel((s) => s.runId === run.id && s.owner === owner)

  return (
    <div
      className="v3-subagent"
      data-testid="v3-subagent-line"
      data-state={model.outcomeKey}
      data-terminal={model.terminal ? '1' : '0'}
      data-selected={selected ? '1' : undefined}
      data-attention={model.attention || !!model.error ? '1' : undefined}
    >
      <button
        className="v3-subagent-toggle"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={selected}
        title={`${model.task}\n${tt('subagentDetailHint')}`}
        onClick={(event) => useSubagentPanel.getState().toggle(run.id, owner, event.currentTarget)}
        data-testid="v3-subagent-toggle"
      >
        <span className="v3-subagent-glyph" data-tone={dotClass}>
          {dotClass === 'run' ? <Busy /> : <Icon name="layers" size={15} />}
          <span className={`v3-dot ${dotClass}`} data-testid="v3-subagent-dot" />
        </span>
        <span className="v3-subagent-main">
          <span className="v3-subagent-task" data-testid="v3-subagent-task">{compactTaskPaths(firstLine(model.task))}</span>
          <span className="v3-subagent-meta">
            <span className="v3-subagent-kind">{tt('subagentKind')}</span>
            {model.code ? <span className="v3-subagent-code" data-testid="v3-subagent-code">{model.code}</span> : null}
            <span className="v3-subagent-status" data-testid="v3-subagent-status">{status}</span>
            <span className="v3-subagent-time" data-testid="v3-subagent-time">{formatDuration(model.elapsedMs, { minSeconds: 1 })}</span>
          </span>
        </span>
        <Icon name="chevron-right" size={13} className="v3-chev" />
      </button>
    </div>
  )
}

/** 行里只放任务的第一行；完整任务在详情面板。 */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? text
}

/* 绝对路径：盘符或根斜杠起头，到空白、引号或中日韩字符为止（中文紧跟路径时不被吞掉）。 */
const ABSOLUTE_PATH = /(?<![\w.:/\\])(?:[A-Za-z]:[\\/]|[\\/])[^\s"'`<>|*?()[\]{} -⁯　-〿＀-￯一-鿿]*/g
/** 短于这个长度的路径原样保留，不值得缩写。 */
const SHORT_PATH = 32

/**
 * 标题显示用：把长绝对路径缩写为「…/最后一级目录」（文件则为「…/父目录/文件名」）。
 * 只影响显示；完整任务仍在 `title` 与详情面板里。
 */
export function compactTaskPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, (match) => {
    if (match.length <= SHORT_PATH) return match
    const trailingSlash = /[\\/]$/.test(match)
    const segments = match.split(/[\\/]+/).filter(Boolean)
    if (segments.length < 2) return match
    const last = segments[segments.length - 1]
    const isFile = !trailingSlash && /\.[A-Za-z0-9]{1,8}$/.test(last)
    const tail = isFile && segments.length >= 2 ? `${segments[segments.length - 2]}/${last}` : last
    return `…/${tail}`
  })
}
