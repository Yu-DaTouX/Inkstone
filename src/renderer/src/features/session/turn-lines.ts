/**
 * 会话内三类「行」的纯投影（WP-21c / WP-27a）。
 *
 * 只做取值与判定，不碰 React / store / DOM：
 *   · 错误卡：复用 `shared/model-errors.ts` 的归类，把「有哪些现有动作可用」
 *     折成结构化字段；没有对应 store 动作的类别不编按钮。
 *   · 压缩标记：只决定「显示哪一次压缩」（进行中优先，其次最近一次）；
 *     文案由组件经 `state/compaction-view.ts` 的既有投影生成。
 *   · 分支摘要：按**视图身份**（id / 文件）在当前会话列表里取分叉来源。
 *   · 子 Agent 行：把 `SubagentRun` 与正式运行投影 `RunSnapshot` 合成一行；
 *     有运行快照时以它的阶段为准（只有 `agent_settled` 会落到终态）。
 *
 * 视图归属只经 `state/view-identity.ts` 的配对规则，不用运行实例投影的会话
 * 去补缺，也不自造归属判断。
 */
import type { CompactionRun, SessionSummary, SubagentRun, UIMessage } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import { isTerminalPhase } from '../../../../shared/runs'
import { subagentOutcome, type SubagentOutcomeKey, type SubagentTone } from '../../../../shared/subagent-outcome'
import { classifyModelError, type ModelErrorKind, type ModelErrorQuotaScope } from '../../../../shared/model-errors'
import { sameSessionFile } from '../../state/view-identity'
import type { SessionTextKey } from './text'

/* ------------------------------------------------------------ 错误卡 */

export type ErrorCardAction = 'retry' | 'model' | 'compact'

export interface ErrorCardModel {
  kind: ModelErrorKind
  quotaScope?: ModelErrorQuotaScope
  /** 现有 store 动作里真正可用、能兜住这一类错误的按钮 */
  actions: ErrorCardAction[]
  /** 已脱敏、宿主归类后写好的解释与原因（`turn.error` 本身） */
  body: string
}

/**
 * `modelErrorNotice()` 写好的句子末尾是「原因：<脱敏原文>」。归类必须看
 * 这段原文，不能拿整句去扫：例如限流的解释里带「额度本身未用尽」四个字，
 * 拿整句归会被误判成额度用尽，从而给出错的按钮。没有「原因：」时按整句归。
 */
function classifiableErrorText(body: string): string {
  const marker = '原因：'
  const at = body.lastIndexOf(marker)
  return at >= 0 ? body.slice(at + marker.length).trim() || body : body
}

/**
 * 错误 → 结构化卡片数据。
 *
 * `turn.error` 是主进程用 `modelErrorNotice()` 写好的完整句子（含脱敏原文），
 * 这里再归类一次只是为了决定「能提供哪些动作」；没有对应 store 动作的类别
 * （例如用户取消、额度用尽只能等）返回空数组，组件就不画按钮。
 */
export function errorCardModel(errorText: string | undefined | null): ErrorCardModel | null {
  const body = (errorText ?? '').trim()
  if (!body) return null
  const info = classifyModelError(classifiableErrorText(body))
  const actions: ErrorCardAction[] = []
  switch (info.kind) {
    case 'context':
      actions.push('compact')
      break
    case 'retryable':
      actions.push('retry', 'model')
      break
    case 'quota':
      if (info.quotaScope === 'rate') actions.push('retry')
      actions.push('model')
      break
    case 'auth':
    case 'refused':
    case 'request':
      actions.push('model')
      break
    default:
      /* aborted：本轮已被取消，没有可做的动作 */
      break
  }
  return {
    kind: info.kind,
    ...(info.quotaScope ? { quotaScope: info.quotaScope } : {}),
    actions,
    body
  }
}

/** 错误标题的 text 键（`features/session/text.ts`）。 */
export function errorTitleKey(model: ErrorCardModel): SessionTextKey {
  if (model.kind === 'quota') return model.quotaScope === 'rate' ? 'errorTitleQuotaRate' : 'errorTitleQuotaUsage'
  const map: Record<ModelErrorKind, SessionTextKey> = {
    retryable: 'errorTitleRetryable',
    quota: 'errorTitleQuotaUsage',
    auth: 'errorTitleAuth',
    context: 'errorTitleContext',
    aborted: 'errorTitleAborted',
    refused: 'errorTitleRefused',
    request: 'errorTitleRequest'
  }
  return map[model.kind]
}

/**
 * 找出「这一轮」对应的用户提示，供重试重发。
 *
 * 用回合的第一条助手消息在消息流里定位，再往上找最近一条用户消息；找不到
 * （历史被裁剪 / 分叉续接）就返回 null —— 宁可不给重试按钮，也不拿别的回合
 * 的提示去重发。
 */
export function promptForTurn(
  sourceIds: readonly string[],
  messages: readonly UIMessage[]
): { text: string; images: { data: string; mimeType: string }[] } | null {
  const firstId = sourceIds[0]
  if (!firstId) return null
  const start = messages.findIndex((message) => message.id === firstId)
  /* 定位不到这一轮的起点就不能拿别的回合的提示去重发 */
  if (start < 0) return null
  for (let i = start - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' || !message.text) continue
    const images = (message.images ?? [])
      .filter((image) => !!image.data)
      .map((image) => ({ data: image.data as string, mimeType: image.mimeType }))
    return { text: message.text, images }
  }
  return null
}

/* -------------------------------------------------------- 压缩标记 */

export interface CompactionLineModel {
  run: CompactionRun
  running: boolean
}

/** 进行中的压缩优先于最近一次；两者都没有就不显示这一行。 */
export function compactionLineModel(
  running: CompactionRun | undefined,
  last: CompactionRun | undefined
): CompactionLineModel | null {
  if (running) return { run: running, running: true }
  if (last) return { run: last, running: false }
  return null
}

/* -------------------------------------------------------- 分支摘要 */

/**
 * 当前视图这条会话「分叉自哪句话」。
 *
 * 按视图身份取：先认 id，再认归一化后的会话文件；两条都取不到返回 null。
 */
export function branchOriginOf(
  sessions: readonly SessionSummary[],
  view: { sessionId: string | null; sessionFile: string | null }
): string | null {
  if (view.sessionId) {
    const byId = sessions.find((item) => item.id === view.sessionId)
    if (byId) return byId.branchOrigin?.trim() || null
  }
  if (view.sessionFile) {
    const byPath = sessions.find((item) => sameSessionFile(item.path, view.sessionFile))
    if (byPath) return byPath.branchOrigin?.trim() || null
  }
  return null
}

/* ------------------------------------------------------ 分支 pager */

/**
 * 消息的稳定 `entryId` 签名，只用于决定「何时低频重读原生会话树」。
 *
 * 只取真实 `entryId`（`ChatMessage.entryId`）：实时流不带它，历史从文件同步后才
 * 出现，因此流式期间签名稳定、不会每个 token 重读树；也绝不用合成 `m<序号>` /
 * 文本 / 时间替代。
 */
export function messageEntrySignature(messages: readonly UIMessage[]): string {
  let signature = ''
  for (const message of messages) {
    if (!message.entryId) continue
    signature += `${signature ? '\u0001' : ''}${message.entryId}`
  }
  return signature
}

/* ------------------------------------------------------ 视图边缘 */

export interface ViewEdge {
  /** 这一轮是视图里的第一条助手回合 */
  first: boolean
  /** 这一轮包含视图最后一条消息（或正在流式） */
  last: boolean
}

/**
 * 会话级行（分支摘要 / 压缩标记）只画一次，不随每个回合重复：
 * 分支摘要落在第一条助手回合，压缩标记落在最后一条 —— 都从消息流推出，
 * 不从「运行实例投影」的会话状态猜。
 */
export function viewEdge(sourceIds: readonly string[], messages: readonly UIMessage[], streaming: boolean): ViewEdge {
  if (!sourceIds.length) return { first: false, last: false }
  const firstAssistant = messages.find((message) => message.role === 'assistant')
  const lastMessage = messages[messages.length - 1]
  return {
    first: firstAssistant?.id === sourceIds[0],
    last: !!streaming || (!!lastMessage && sourceIds.includes(lastMessage.id))
  }
}

/* ------------------------------------------------------ 子 Agent 行 */

export interface SubagentLineModel {
  id: string
  /** 正式运行投影给的显示编号（S12·1）；没有就不编 */
  code: string | null
  task: string
  model: string | null
  isolation: SubagentRun['isolation']
  /** 没有运行快照时用 `subagent-outcome` 的说法 */
  outcomeKey: SubagentOutcomeKey
  outcomeTone: SubagentTone
  /** 正式运行投影的阶段；有它时状态以它为准 */
  phase: RunSnapshot['phase'] | null
  live: boolean
  attention: boolean
  /** 终态（快照阶段 done/failed/stopped，或没有快照时的非运行态） */
  terminal: boolean
  elapsedMs: number
  latest: string | null
  error: string | null
  summary: string | null
  summaryTruncated: boolean
  diff: { files: number; additions: number; deletions: number } | null
  sources: string[]
  artifacts: string[]
  review: SubagentRun['review']
}

/**
 * 把一次子 Agent 运行折成一行。
 *
 * 状态：有 `RunSnapshot` 时以它的阶段为准 —— 运行注册表只在 `agent_settled`
 * 之后才落到 done/failed/stopped，所以不会把 `agent_end` 误当终态；没有快照
 * 才退回 `subagent-outcome` 的既有说法。模型 / 编号优先取投影，缺了不编。
 */
export function subagentLineModel(run: SubagentRun, snapshot: RunSnapshot | undefined, now: number): SubagentLineModel {
  const outcome = subagentOutcome(run)
  const phase = snapshot?.phase ?? null
  const terminal = phase ? isTerminalPhase(phase) : !outcome.live
  const terminalAt = phase && (phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'stopped') ? phase.at : undefined
  const endedAt = run.endedAt ?? terminalAt
  const elapsedMs = Math.max(0, (endedAt ?? now) - run.startedAt)
  const model = snapshot?.model
    ? [snapshot.model.label || snapshot.model.id, snapshot.model.thinking].filter(Boolean).join(' · ')
    : run.model ?? null
  const result = run.result
  const summary = result?.summary?.trim() ? result.summary : null
  const diff = run.diff && run.diff.files > 0
    ? { files: run.diff.files, additions: run.diff.additions, deletions: run.diff.deletions }
    : null
  return {
    id: run.id,
    code: snapshot?.code ?? null,
    task: run.brief?.goal?.trim() || run.task,
    model,
    isolation: run.isolation,
    outcomeKey: outcome.key,
    outcomeTone: outcome.tone,
    phase,
    live: phase ? !isTerminalPhase(phase) : outcome.live,
    attention: outcome.attention,
    terminal,
    elapsedMs,
    latest: run.latestActivity?.trim() || null,
    error: run.error?.trim() || null,
    summary,
    summaryTruncated: !!result?.summaryTruncated,
    diff,
    sources: result?.sources ?? [],
    artifacts: result?.artifacts ?? [],
    review: run.review
  }
}

/** 运行快照里属于这次子 Agent 的那条（主进程若用子 Agent id 作 runId）。 */
export function findSubagentSnapshot(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
  return runs.find((run) => run.kind === 'subagent' && run.runId === runId)
}
