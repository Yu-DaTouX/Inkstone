/**
 * 一轮对话的渲染：用户消息 / 助手回合 / 用户执行的 `!` 命令。
 *
 * 参考 v2 `chat/TurnView.tsx` 的回合结构与展示规则（一笔回答 = 一块、
 * 解说与正式回复分段、活动行固定在回合顶部、回复下方才是用时/模型/复制），
 * 但不引入 v2 控件与 v2 CSS；正文、思考、步骤分别由本目录的
 * `Markdown` / `Thinking` / `ToolSteps` 负责。
 *
 * v3 尚未迁移的能力（生图进度、并排打开子 Agent、回退对话框）
 * 在这里给出**明确可见的回退提示**或标注占位，不静默丢弃、也不伪造交互。
 * 子 Agent 行、错误卡、压缩标记与分支摘要由本目录的 `SubagentLine` /
 * `ErrorCard` / `CompactionMarker` / `BranchSummary` 负责。
 */
import { memo, useEffect, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useSessionText } from './text'
import { Markdown } from './Markdown'
import { TurnArtifacts } from './MessageParts'
import { ThinkingLine } from './Thinking'
import { ToolSteps } from './ToolSteps'
import { TurnProcess } from './TurnProcess'
import { splitTurnProcess } from './turn-process'
import { MessageImage } from './Image'
import { Icon } from './Icon'
import { Busy } from './Busy'
import { IconButton } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { matchCheckpoint } from '../../../../shared/checkpoints'
import { forkFromText } from '../../lib/fork'
import { isSubagentNotice } from '../../../../shared/subagent-notice'
import { runPhaseText, useRunProgress } from '../../components/chat/run-status'
import { turnModelLabel } from './turn-model-label'
import { ErrorCard } from './ErrorCard'
import { CompactionMarker } from './CompactionMarker'
import { BranchSummary } from './BranchSummary'
import { SubagentLine } from './SubagentLine'
import { TurnChanges } from './TurnChanges'
import { viewEdge } from './turn-lines'
import { BranchPager, type BranchPagerBinding } from './BranchPager'
import type { AssistantTurn, BashTurn, Turn, UserTurn } from '../../../../shared/turns'

export const TurnView = memo(function TurnView({ turn, streaming, readOnly = false, sessionId = null, rewindOwner = null, branchPager }: { turn: Turn; streaming?: boolean; readOnly?: boolean; sessionId?: string | null; rewindOwner?: string | null; branchPager?: BranchPagerBinding }): JSX.Element | null {
  if (turn.kind === 'user') return <UserTurnView turn={turn} readOnly={readOnly} rewindOwner={rewindOwner} branchPager={branchPager} />
  if (turn.kind === 'bash') return <BashTurnView turn={turn} />
  return <AssistantTurnView turn={turn} streaming={streaming} readOnly={readOnly} sessionId={sessionId} rewindOwner={rewindOwner} />
})

/* ------------------------------------------------------------------ 用户 */

function UserTurnView({ turn, readOnly, rewindOwner, branchPager }: { turn: UserTurn; readOnly: boolean; rewindOwner: string | null; branchPager?: BranchPagerBinding }): JSX.Element | null {
  const t = useT()
  const msg = turn.msg
  const checkpoints = useStore((s) => s.checkpoints)
  const openRewind = useStore((s) => s.openRewind)
  /*
   * 分支 pager 只认这条用户消息自己的稳定 `entryId`（`ChatMessage.entryId`），
   * 在 `SessionView` 投影出的模型表里查；查不到（无 id / 无真实兄弟分支）就不画。
   * 分支树已由右侧「分支」页提供，这里只是同一分叉点旁的行内切换入口。
   */
  const pagerModel = msg.entryId ? branchPager?.models.get(msg.entryId) ?? null : null
  /*
   * 回退代码只认**属于当前活动会话**的检查点：先按会话键过滤再匹配指纹，
   * 不拿别的会话的记录凑数。`rewindOwner` 在视图失活（peek 别人 / 并排非焦点
   * 归属不符）时为 null，于是这里不画按钮——宁可隐藏，也不操作全局当前会话。
   * 回退只恢复项目文件，不碰对话、不自动分叉（分叉入口是上面的「分支」）。
   */
  const owned = rewindOwner ? checkpoints.filter((record) => record.sessionKey === rewindOwner) : []
  const checkpoint = !readOnly && msg.text ? matchCheckpoint(owned, msg.text, msg.timestamp) : null
  if (isSubagentNotice(msg.text)) return null
  return (
    <article className="v3-msg user" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="v3-user-body">
        {msg.question ? (
          <span className="v3-tag" data-testid="v3-question-tag">
            <Icon name="message" size={12} />
            {t('chat.questionTag')}
          </span>
        ) : null}

        {msg.images?.length ? (
          <div className="v3-user-images">
            {msg.images.map((im, i) =>
              im.data ? <MessageImage key={i} src={`data:${im.mimeType};base64,${im.data}`} className="v3-img-thumb" /> :
              im.url ? <MessageImage key={i} src={im.url} className="v3-img-thumb" /> :
              <div key={i} className="v3-img-missing" title={t('chat.imageMissing')}><Icon name="image" size={12} /><span>{t('chat.imageMissing')}</span></div>
            )}
          </div>
        ) : null}

        {msg.qa?.length ? (
          <div className="v3-qa" data-testid="v3-question-qa">
            {msg.qa.map((item, i) => (
              <div key={i} className="v3-qa-item">
                <details className="v3-qa-q"><summary>{item.question}</summary></details>
                {item.answer ? <div className="v3-qa-a">{item.answer}</div> : null}
              </div>
            ))}
          </div>
        ) : msg.text ? (
          <div className="v3-bubble">
            <span className="v3-bubble-prompt" aria-hidden>›</span>
            <span className="v3-bubble-text">{msg.text}</span>
          </div>
        ) : null}

        <div className="v3-msg-meta">
          {pagerModel && branchPager ? (
            <BranchPager
              model={pagerModel}
              disabled={branchPager.disabled}
              pending={branchPager.pending !== null}
              error={branchPager.error}
              onNavigate={branchPager.onNavigate}
            />
          ) : null}
          {msg.timestamp ? <TurnClock timestamp={msg.timestamp} /> : null}
          {!readOnly && msg.text ? (
            <button className="v3-msg-act" title={t('chat.forkHere')} onClick={() => void forkFromText(msg.text)}>
              <Icon name="branch" size={12} />
              {t('chat.fork')}
            </button>
          ) : null}
          {checkpoint ? (
            <button className="v3-msg-act" title={t('chat.rewindHere')} onClick={() => openRewind(checkpoint.id, msg.text)} data-testid="v3-msg-rewind">
              <Icon name="back" size={12} />
              {t('chat.rewind')}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  )
}

/* -------------------------------------------------------- 用户执行的 ! 命令 */

function BashTurnView({ turn }: { turn: BashTurn }): JSX.Element {
  const t = useT()
  const msg = turn.msg
  return (
    <article className="v3-msg bash" data-msg-id={msg.id} data-turn-id={turn.id}>
      <div className="v3-tag">{t('chat.bash')}</div>
      <ToolSteps tools={msg.toolCalls ?? []} />
      {msg.error ? <div className="v3-error" role="alert"><Icon name="warn" size={13} /><span>{msg.error}</span></div> : null}
    </article>
  )
}

/* ------------------------------------------------------------------ 助手 */

function failedCount(turn: AssistantTurn): number {
  return turn.tools.filter((c) => c.status === 'error' && !c.cancelled).length
}

/** 回复正文（复制用）：优先分段回复，其次整轮回复 */
export function replyText(turn: AssistantTurn): string {
  const text = (turn.segments.length
    ? turn.segments.flatMap((segment) => segment.response ? [segment.response.text] : [])
    : [turn.response?.text ?? '']).join('\n\n').trim()
  return text
}

function AssistantTurnView({ turn, streaming, readOnly, sessionId, rewindOwner }: { turn: AssistantTurn; streaming?: boolean; readOnly: boolean; sessionId: string | null; rewindOwner: string | null }): JSX.Element | null {
  /*
   * 只订阅消息条数，避免每个助手回合都随流式 token 重渲染；条数变化（新增消息 /
   * 换会话由 turn prop 变化触发）时再取一次消息流算首 / 末边缘。
   */
  useStore((s) => s.messages.length)
  const messages = useStore.getState().messages
  const promoted = turn.response?.hasTools ? (turn.responseParts?.length ? turn.responseParts : [turn.response]) : []
  const commentary = promoted.length ? [...turn.commentary, ...promoted] : turn.commentary
  const liveImageProgress = turn.imageProgress.filter((item) => item.stage !== 'done')
  const hasBody = commentary.length > 0 || !!turn.response || turn.tools.length > 0 || !!turn.thinking || turn.artifacts.length > 0 || liveImageProgress.length > 0 || !!turn.error
  const edge = viewEdge(turn.sourceIds, messages, !!streaming)
  if (!hasBody && !streaming) return null
  /* 按真实发生顺序穿插：解说 → 这一批工具的一行摘要 → 正文；覆盖不全时退回旧排法，不丢内容。 */
  const flow = flowSegments(turn, commentary)
  /* 过程收拢：回复之前的旁白与工具组合成一行；完成后，推理块也收进过程行内部 */
  const split = flow ? splitTurnProcess(flow) : null
  const processSegs = split?.process ?? []
  const thinkingInProcess = !streaming && processSegs.length > 0
  const thinkingLine = <ThinkingLine text={turn.thinking ?? ''} ms={turn.thinkingMs} live={turn.thinkingLive} />

  return (
    <article className={`v3-msg assistant ${streaming ? 'streaming' : ''}`} data-turn-id={turn.id} data-tools={turn.tools.length}>
      <div className="v3-assistant-body">
        {edge.first ? <BranchSummary /> : null}
        <TurnActivity turn={turn} streaming={streaming} />
        {thinkingInProcess ? null : thinkingLine}

        {turn.error ? <ErrorCard sourceIds={turn.sourceIds} error={turn.error} /> : null}

        {split ? (
          <>
            {processSegs.length ? (
              <TurnProcess
                process={processSegs}
                elapsedMs={turn.elapsedMs}
                live={!!streaming && !split.reply}
                thinking={thinkingInProcess ? thinkingLine : null}
                sessionId={sessionId}
              />
            ) : null}
            {split.reply ? (
              <div className="v3-seg" data-testid="v3-seg">
                <div className="v3-para">
                  <Markdown text={split.reply.response?.text ?? ''} sourceCwd={split.reply.response?.sourceCwd} live={!!streaming && split.reply.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={split.reply.response?.id ?? split.reply.id} />
                </div>
              </div>
            ) : null}
            {split.tail.map((seg, si) => {
              const last = si === split.tail.length - 1
              return (
                <div key={seg.id} className="v3-seg" data-testid="v3-seg">
                  {seg.commentary.length ? (
                    <div className="v3-commentary">
                      {seg.commentary.map((part, i) => (
                        <div key={part.id} className="v3-para dim">
                          <Markdown text={part.text} sourceCwd={part.sourceCwd} live={!!streaming && last && !seg.response && i === seg.commentary.length - 1} sessionId={sessionId} messageId={part.id} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <ToolSteps tools={seg.tools} />
                  {seg.response ? (
                    <div className="v3-para">
                      <Markdown text={seg.response.text} sourceCwd={seg.response.sourceCwd} live={!!streaming && seg.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={seg.response.id} />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </>
        ) : (
          <>
            {commentary.length ? (
              <div className="v3-commentary">
                {commentary.map((part, i) => (
                  <div key={part.id} className="v3-para dim">
                    <Markdown text={part.text} sourceCwd={part.sourceCwd} live={!!streaming && i === commentary.length - 1} sessionId={sessionId} messageId={part.id} />
                  </div>
                ))}
              </div>
            ) : null}
            {turn.segments.length
              ? turn.segments.map((segment) => segment.response ? (
                  <div key={segment.id} className="v3-para">
                    <Markdown text={segment.response.text} sourceCwd={segment.response.sourceCwd} live={!!streaming && segment.sourceMessageId === turn.sourceIds.at(-1)} sessionId={sessionId} messageId={segment.response.id} />
                  </div>
                ) : null)
              : turn.response && !turn.response.hasTools
                ? <div className="v3-para"><Markdown text={turn.response.text} sourceCwd={turn.response.sourceCwd} live={!!streaming} sessionId={sessionId} messageId={turn.response.id} /></div>
                : null}
            <ToolSteps tools={turn.tools} />
          </>
        )}

        {/* 已完成成果走受控预览；生图进度仍明确标注迁移边界。 */}
        {turn.artifacts.length ? <TurnArtifacts artifacts={turn.artifacts} sessionId={sessionId} messageId={turn.id} /> : null}
        {liveImageProgress.length ? <ImageProgressFallbackNote /> : null}

        {/* 子 Agent 行：正式运行投影 + 现有子代理投影合成；并排打开未迁移 */}
        <SubagentLine turn={turn} />

        {/* 压缩标记是会话级事件，只画在最后一条助手回合，避免每个回合一串 */}
        {edge.last ? <CompactionMarker /> : null}

        {streaming && !turn.response && !commentary.length && !turn.tools.length && !turn.thinking ? <span className="v3-caret" aria-hidden>▍</span> : null}
        {!streaming ? <TurnChanges turn={turn} readOnly={readOnly} rewindOwner={rewindOwner} /> : null}
        {!streaming ? <TurnMeta turn={turn} readOnly={readOnly} /> : null}
      </div>
    </article>
  )
}

/**
 * 按段穿插所需的数据；任何一条解说 / 工具在分段里找不到就返回 null（整轮退回旧排法）。
 * 这样分段投影漏项时，界面最多是排法变回去，不会少一块内容。
 */
function flowSegments(turn: AssistantTurn, commentary: readonly { id: string }[]): AssistantTurn['segments'] | null {
  if (!turn.segments.length) return null
  const toolCount = turn.segments.reduce((sum, seg) => sum + seg.tools.length, 0)
  if (toolCount !== turn.tools.length) return null
  const covered = new Set<string>()
  for (const seg of turn.segments) {
    for (const part of seg.commentary) covered.add(part.id)
    if (seg.response) covered.add(seg.response.id)
  }
  if (commentary.some((part) => !covered.has(part.id))) return null
  if (turn.response && !turn.response.hasTools && !covered.has(turn.response.id)) return null
  return turn.segments
}

/** 只有仍在生成的图片使用回退提示，不遮掉已经可用的成果。 */
function ImageProgressFallbackNote(): JSX.Element {
  const tt = useSessionText()
  return (
    <div className="v3-fallback-note" data-testid="v3-image-progress-fallback">
      <Icon name="layers" size={13} />
      <span>{tt('imageProgress')}</span>
    </div>
  )
}

/** 回合顶部的活动行：运行 / 完成 / 失败 / 停止，原地更新 */
function TurnActivity({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }): JSX.Element {
  return streaming ? <LiveActivity /> : <SettledActivity turn={turn} />
}

/** 运行中才挂心跳（每秒重渲染一次），历史回合不进这里，避免 N 个计时器 */
function LiveActivity(): JSX.Element {
  const t = useT()
  const progress = useRunProgress()
  const compaction = useStore((s) => s.session?.compaction)
  /* 跑工具时不重复写命令：命令就在下面那一步的行里，这里只说阶段 */
  const text = (progress?.phase === 'tool' ? t('chat.working') : runPhaseText(t, progress, compaction)) || t('chat.working')
  return (
    <div className="v3-act" data-kind="run" data-testid="v3-turn-activity">
      <Busy />
      <span className="v3-act-text" role="status" aria-live="polite">{text}</span>
      {progress ? <span className="v3-act-time">{formatDuration(progress.elapsedMs)}</span> : null}
    </div>
  )
}

function SettledActivity({ turn }: { turn: AssistantTurn }): JSX.Element {
  const t = useT()
  const failed = failedCount(turn)
  const reason = turn.terminalReason
  const kind = reason === 'failed' || (turn.error && reason !== 'stopped') ? 'err'
    : reason === 'stopped' ? 'stop'
      : reason === 'interrupted' ? 'stop'
        : failed > 0 ? 'err' : 'done'
  const glyph = kind === 'err' ? '✕' : kind === 'stop' ? '■' : '✓'
  const label = turn.error || reason === 'failed' ? t('act.failed')
    : reason === 'stopped' ? t('act.stopped')
      : reason === 'interrupted' ? t('act.interrupted')
        : failed > 0 ? t('act.partial') : t('act.done')
  return (
    <div className="v3-act" data-kind={kind} data-testid="v3-turn-activity">
      <span className="v3-act-glyph" aria-hidden>{glyph}</span>
      <span className="v3-act-text">{label}</span>
    </div>
  )
}

/** 回复下方一行：完成时刻 · 模型 · 用时 · 复制 */
function TurnMeta({ turn, readOnly }: { turn: AssistantTurn; readOnly: boolean }): JSX.Element | null {
  const t = useT()
  const models = useStore((s) => s.models)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return undefined
    const timer = window.setTimeout(() => setCopyState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const reply = replyText(turn)
  const elapsed = turn.elapsedMs && turn.elapsedMs > 0 ? formatDuration(turn.elapsedMs) : null
  const modelDisplay = turn.model ? turnModelLabel(turn.model, models) : null
  if (!reply && !turn.timestamp && !elapsed && !turn.model) return null
  return (
    <div className="v3-msg-meta" data-testid="v3-turn-meta">
      {turn.timestamp ? <TurnClock timestamp={turn.timestamp} /> : null}
      {modelDisplay ? <span className="v3-act-model" title={modelDisplay.identity}>{modelDisplay.label}</span> : null}
      {elapsed ? <span className="v3-act-time" title={turn.waitMs ? t('tok.elapsedWaitTip', { n: formatDuration(turn.waitMs) }) : t('tok.elapsedTip')}>{elapsed}</span> : null}
      {reply && !readOnly ? (
        <IconButton
          size="sm"
          aria-label={t(copyState === 'copied' ? 'turn.copied' : copyState === 'failed' ? 'turn.copyFailed' : 'turn.copy')}
          data-testid="v3-turn-copy"
          isDisabled={turn.streaming}
          onPress={() => void navigator.clipboard.writeText(reply).then(() => setCopyState('copied'), () => setCopyState('failed'))}
        >
          <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} />
        </IconButton>
      ) : null}
    </div>
  )
}

/** 完成时刻：悬停 / 聚焦都能读到完整时间 */
export function TurnClock({ timestamp }: { timestamp: number }): JSX.Element | null {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  const full = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  }).format(date)
  return <time className="v3-time" dateTime={date.toISOString()} title={full} aria-label={full} tabIndex={0}>{clock}</time>
}
