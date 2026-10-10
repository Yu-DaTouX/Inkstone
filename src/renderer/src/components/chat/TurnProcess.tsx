import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { formatDuration } from '../../../../shared/duration'
import type { AssistantTurn } from '../../../../shared/turns'
import { withScrollAnchor } from '../../lib/scrollAnchor'
import { IconButton } from '../ui'
import { ReasoningCapsule } from './Reasoning'
import { ToolGroup } from './ToolRow'
import { runPhaseText, useRunProgress } from './run-status'

/**
 * 回合的活动行与执行过程（设计规范「界面重构」）。
 *
 * 活动行：每轮助手回复顶部固定一行，原地更新——字符状态 + 状态文字 + 计数 + 用时。
 * 运行中的旋转字符是整个窗口唯一的主要运行信号。
 *
 * 过程：推理入口与工具调用树。默认折叠为一行摘要，展开是 `├─ └─` 调用树。
 * 「阅读优先」放在正文之后；「过程并列」由样式把同一个元素放到右侧一栏
 * （chat.css 的 `.tproc`），不复制组件与展开状态。
 */

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 盲文旋转字符；减少动效时是静态的 `●` */
function Spin() {
  const [i, setI] = useState(0)
  const still = reducedMotion()
  useEffect(() => {
    if (still) return undefined
    const id = window.setInterval(() => setI((n) => n + 1), 90)
    return () => window.clearInterval(id)
  }, [still])
  return <>{still ? '●' : FRAMES[i % FRAMES.length]}</>
}

function failedCount(turn: AssistantTurn): number {
  return turn.tools.filter((c) => c.status === 'error' && !c.cancelled).length
}

/** 回复正文，用于复制 */
function replyText(turn: AssistantTurn): string {
  return (turn.segments.length
    ? turn.segments.flatMap((segment) => segment.response ? [segment.response.text] : [])
    : [turn.response?.text ?? '']).join('\n\n').trim()
}

/* ------------------------------------------------------------ 活动行 */

export function TurnActivityLine({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  return streaming ? <LiveActivity /> : <SettledActivity turn={turn} />
}

/** 运行中的那一轮：阶段文字与计时来自 run-status，和输入框的「停止 + 计时」同拍 */
function LiveActivity() {
  const t = useT()
  const progress = useRunProgress()
  const compaction = useStore((s) => s.session?.compaction)
  const waiting = useStore((s) => {
    const ids = [s.session?.sessionId, s.session?.conversationId]
    return s.approvals.some((a) => !a.sessionId || ids.includes(a.sessionId))
  })
  const text = runPhaseText(t, progress, compaction) || t('chat.working')
  return (
    <div className="tact" data-kind={waiting ? 'wait' : 'run'} data-testid="turn-footer">
      <span className="tact-glyph" aria-hidden>{waiting ? '◆' : <Spin />}</span>
      <span className="tact-k" data-testid="working" role="status" aria-live="polite">{waiting ? t('act.wait') : text}</span>
      {/* 步数与失败数在紧邻的「过程」摘要里，这里不重复 */}
      <span className="tact-sp" />
      {progress ? <span className="tact-time">{formatDuration(progress.elapsedMs)}</span> : null}
    </div>
  )
}

/** 已结束的一轮：完成 / 部分完成 / 失败 / 停止与步数；时间、用时、复制在回合下方（TurnMeta） */
function SettledActivity({ turn }: { turn: AssistantTurn }) {
  const t = useT()
  const failed = failedCount(turn)
  const reason = turn.terminalReason
  const kind = reason === 'failed' || (turn.error && reason !== 'stopped') ? 'err'
    : reason === 'stopped' || reason === 'interrupted' ? 'stop'
      : failed > 0 ? 'err' : 'done'
  const glyph = kind === 'err' ? '✕' : kind === 'stop' ? '■' : '✓'
  const label = reason === 'failed' || turn.error ? t('act.failed')
    : reason === 'stopped' ? t('act.stopped')
      : reason === 'interrupted' ? t('act.interrupted')
        : failed > 0 ? t('act.partial') : t('act.done')

  return (
    <div className="tact" data-kind={kind} data-testid="turn-status">
      <span className="tact-glyph" aria-hidden>{glyph}</span>
      <span className="tact-k">{label}</span>
      <span className="tact-sp" />
    </div>
  )
}

/** 回合下方的一行：复制、完成时刻、用时。运行中不显示（运行时间在顶部活动行）。 */
export function TurnMeta({ turn }: { turn: AssistantTurn }) {
  const t = useT()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(() => setCopyState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [copyState])
  const reply = replyText(turn)
  const elapsed = turn.elapsedMs && turn.elapsedMs > 0 ? formatDuration(turn.elapsedMs) : null
  if (!reply && !turn.timestamp && !elapsed) return null
  return (
    <div className="tact tact-foot" data-testid="turn-footer">
      {turn.timestamp ? <TurnClock timestamp={turn.timestamp} /> : null}
      {elapsed ? (
        <span className="tact-time" title={turn.waitMs ? t('tok.elapsedWaitTip', { n: formatDuration(turn.waitMs) }) : t('tok.elapsedTip')}>{elapsed}</span>
      ) : null}
      {reply ? <IconButton
        size="sm"
        className="tact-copy"
        icon={copyState === 'copied' ? 'check' : 'copy'}
        label={t(copyState === 'copied' ? 'turn.copied' : copyState === 'failed' ? 'turn.copyFailed' : 'turn.copy')}
        data-testid="turn-copy"
        disabled={turn.streaming}
        onClick={() => void navigator.clipboard.writeText(reply).then(() => setCopyState('copied'), () => setCopyState('failed'))}
      /> : null}
    </div>
  )
}

/** 完成时刻：悬停、聚焦都能读到完整时间（键盘可达，屏幕阅读器读 aria-label） */
export function TurnClock({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return null
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  const full = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  }).format(date)
  return (
    <time className="turn-footer-item turn-time" dateTime={date.toISOString()} title={full} aria-label={full} data-full={full} tabIndex={0}>
      {clock}
    </time>
  )
}

/* ------------------------------------------------------------ 过程 */

/** `hideReasoning`：推理已经放在回合顶部（实时显示思考链），过程里只留工具 */
export function TurnProcess({ turn, streaming, hideReasoning = false }: { turn: AssistantTurn; streaming?: boolean; hideReasoning?: boolean }) {
  const t = useT()
  const side = useStore((s) => s.settings?.processLayout === 'side' || s.settings?.processLayout === 'left')
  /* 手动开合优先；没动过时并列在回合进行中展开、回复完成后自动折叠，阅读优先始终折叠 */
  const [manual, setManual] = useState<boolean | null>(null)
  const tools = turn.tools
  const thinking = hideReasoning ? '' : turn.thinking
  if (!thinking && tools.length === 0) return null
  const open = manual ?? (side && !!streaming)

  const running = tools.filter((c) => c.status === 'running' || c.status === 'pending')
  const activeToolId = running.length ? running[running.length - 1].id : null
  const failed = failedCount(turn)
  const reasonSecs = turn.thinkingMs ? Math.max(1, Math.round(turn.thinkingMs / 1000)) : null

  return (
    <section className={`tproc ${open ? 'open' : ''}`} data-testid="turn-process" aria-label={t('proc.label')}>
      <button
        className="tproc-sum"
        aria-expanded={open}
        data-testid="turn-process-toggle"
        onClick={(e) => {
          const row = e.currentTarget.parentElement
          withScrollAnchor(row, () => setManual(!open))
        }}
      >
        <span className="tproc-tw" aria-hidden>›</span>
        <span className="tproc-name">{t('proc.title')}</span>
        <span className="tproc-meta">
          {tools.length ? <span>{t('turn.steps', { n: tools.length })}</span> : null}
          {thinking ? <span>{reasonSecs ? t('proc.reason', { n: reasonSecs }) : t('reason.past')}</span> : null}
          {failed > 0 ? <span className="err">{t('proc.failed', { n: failed })}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="tproc-tree">
          {thinking ? (
            <ReasoningCapsule text={thinking} ms={turn.thinkingMs} live={turn.thinkingLive} turnLive={streaming} />
          ) : null}
          <ToolGroup tools={tools} activeId={activeToolId} />
        </div>
      ) : null}
    </section>
  )
}

