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
import { resolveTurnModelDisplay } from './turn-model-display'

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

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

function replyText(turn: AssistantTurn): string {
  return (turn.segments.length
    ? turn.segments.flatMap((segment) => segment.response ? [segment.response.text] : [])
    : [turn.response?.text ?? '']).join('\n\n').trim()
}

export function TurnActivityLine({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  return streaming ? <LiveActivity /> : <SettledActivity turn={turn} />
}

export function PendingActivity() {
  return (
    <div className="stream-pending">
      <LiveActivity />
    </div>
  )
}

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
      <span className="tact-sp" />
      {progress ? <span className="tact-time">{formatDuration(progress.elapsedMs)}</span> : null}
    </div>
  )
}

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
  const models = useStore((s) => s.models)
  const favorites = useStore((s) => s.settings?.modelFavorites)
  const currentModel = useStore((s) => s.session?.model)
  const fallbackModels = [...(favorites ?? []), ...(currentModel ? [currentModel] : [])]
  const modelDisplay = turn.model ? resolveTurnModelDisplay(turn.model, models, fallbackModels) : null
  if (!reply && !turn.timestamp && !elapsed && !turn.model) return null
  return (
    <div className="tact tact-foot" data-testid="turn-footer">
      {turn.timestamp ? <TurnClock timestamp={turn.timestamp} /> : null}
      {modelDisplay ? <span className="tact-model" title={`${t('status.model')}: ${modelDisplay.label} (${modelDisplay.identity})`} aria-label={`${t('status.model')}: ${modelDisplay.label} (${modelDisplay.identity})`} data-testid="turn-model">{modelDisplay.label}</span> : null}
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

export function TurnProcess({ turn, streaming, hideReasoning = false }: { turn: AssistantTurn; streaming?: boolean; hideReasoning?: boolean }) {
  const t = useT()
  const side = useStore((s) => s.settings?.processLayout === 'side' || s.settings?.processLayout === 'left')
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

