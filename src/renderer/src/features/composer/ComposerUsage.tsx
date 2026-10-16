import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from 'react-aria-components'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Popover } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { formatHitRate } from '../../../../shared/turns'
import { projectSessionMetrics, type SessionMetrics } from '../../../../shared/session-metrics'
import type { ReactNode } from 'react'

type OpenPanel = 'session' | 'tokens' | null

function sumTime(ms: number | null, partial: boolean): string {
  if (ms === null) return '—'
  return `${partial ? '≥' : ''}${ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms)}`
}

function avgTime(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms)
}

function tpsText(m: SessionMetrics, perSec: string): string {
  return m.tps === null ? '—' : `${m.tps >= 100 ? Math.round(m.tps) : m.tps.toFixed(1)} ${perSec}`
}

function tokenText(n: number | null, partial: boolean, unit: string): string {
  if (n === null) return '—'
  return `${partial ? '≥' : ''}${n.toLocaleString()} ${unit}`
}

function countText(n: number, partial: boolean): string {
  return `${partial ? '≥' : ''}${n}`
}

function abbrevCount(n: number): string {
  const trim = (v: number): string => {
    const s = v.toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) : s
  }
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}K`
  return String(n)
}

function abbrevToken(n: number | null, partial: boolean, unit: string): string {
  if (n === null) return '—'
  return `${partial ? '≥' : ''}${abbrevCount(n)} ${unit}`
}

export function ComposerUsage() {
  const t = useT()
  const enabled = useStore((s) => s.settings?.usageUnderInput !== false)
  const messages = useStore((s) => s.messages)
  const stats = useStore((s) => s.stats)
  const sessionKey = useStore((s) => s.peekedSessionId ?? s.session?.sessionId ?? s.session?.conversationId ?? null)
  const peekNote = useStore((s) => s.peekNote)
  const historyPartial = (peekNote?.truncated ?? 0) > 0
  const metrics = useMemo(
    () => projectSessionMetrics(messages, stats, { historyPartial }),
    [messages, stats, historyPartial]
  )

  const [open, setOpen] = useState<OpenPanel>(null)
  const sessionTrigger = useRef<HTMLButtonElement>(null)
  const tokenTrigger = useRef<HTMLButtonElement>(null)

  const boundSession = useRef(sessionKey)
  useEffect(() => {
    if (boundSession.current === sessionKey) return
    boundSession.current = sessionKey
    setOpen(null)
  }, [sessionKey])

  useEffect(() => {
    if (!enabled) setOpen(null)
  }, [enabled])

  if (!enabled) return null
  const showSession = metrics.steps > 0 || metrics.turns > 0
  const showTokens = metrics.total !== null || metrics.steps > 0
  if (!showSession && !showTokens) return null

  const sessionName = t('sm.title.session')
  const tokensName = t('sm.title.tokens')
  const title = open === 'tokens' ? tokensName : sessionName

  const sessionRows: [string, ReactNode][] = [
    [t('sm.turns'), countText(metrics.turns, historyPartial)],
    [t('sm.steps'), countText(metrics.steps, historyPartial)],
    [t('sm.modelTime'), sumTime(metrics.modelMs, metrics.modelPartial)],
    [t('sm.toolTime'), sumTime(metrics.toolMs, metrics.toolPartial)],
    [t('sm.ttft'), avgTime(metrics.ttftMs)],
    [t('sm.tps'), tpsText(metrics, t('tok.perSec'))]
  ]
  const tokenRows: [string, ReactNode][] = [
    [t('sm.total'), tokenText(metrics.total, metrics.partial, t('tok.unit'))],
    [t('sm.hitRate'), formatHitRate(metrics.hitRate) ?? '—'],
    [t('sm.inputUncached'), tokenText(metrics.input, metrics.partial, t('tok.unit'))],
    [t('sm.cacheRead'), tokenText(metrics.cacheRead, metrics.partial, t('tok.unit'))],
    ...(metrics.cacheWrite === null
      ? []
      : [[t('sm.cacheWrite'), tokenText(metrics.cacheWrite, metrics.partial, t('tok.unit'))] as [string, ReactNode]]),
    [t('sm.output'), tokenText(metrics.output, metrics.partial, t('tok.unit'))]
  ]
  const rows = open === 'tokens' ? tokenRows : sessionRows

  return (
    <div className="composer-usage ui-meta-num" data-testid="composer-usage">
      {showSession ? (
        <Button
          ref={sessionTrigger}
          size="sm"
          variant="ghost"
          className="cu-trigger"
          data-testid="composer-usage-session"
          title={t('sm.sessionTip')}
          aria-haspopup="dialog"
          aria-expanded={open === 'session'}
          onPress={() => setOpen((v) => (v === 'session' ? null : 'session'))}
        >
          {t('sm.summary', {
            turns: countText(metrics.turns, historyPartial),
            steps: countText(metrics.steps, historyPartial),
            tps: tpsText(metrics, t('tok.perSec'))
          })}
        </Button>
      ) : null}
      {showTokens ? (
        <Button
          ref={tokenTrigger}
          size="sm"
          variant="ghost"
          className="cu-trigger"
          data-testid="composer-usage-tokens"
          title={t('sm.tokensTip')}
          aria-haspopup="dialog"
          aria-expanded={open === 'tokens'}
          onPress={() => setOpen((v) => (v === 'tokens' ? null : 'tokens'))}
        >
          {`${abbrevToken(metrics.total, metrics.partial, t('tok.unit'))} · ${formatHitRate(metrics.hitRate) ?? '—'}`}
        </Button>
      ) : null}
      <Popover
        isOpen={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null)
        }}
        triggerRef={open === 'tokens' ? tokenTrigger : sessionTrigger}
        placement="top start"
        offset={8}
        className="cu-pop"
      >
        <Dialog className="cu-dialog" aria-label={title} data-testid="composer-usage-details">
          <p className="cu-title">{title}</p>
          <dl className="cu-kv">
            {rows.map(([k, v], i) => (
              <div key={i} className="cu-kv-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {open === 'tokens' && metrics.partial ? <p className="cu-note">{t('sm.partialTip')}</p> : null}
          {open === 'session' && historyPartial ? <p className="cu-note">{t('sm.historyPartialTip')}</p> : null}
          {open === 'session' &&
          (metrics.modelPartial || metrics.toolPartial || metrics.ttftPartial || metrics.tpsPartial) ? (
            <p className="cu-note">{t('sm.timingPartialTip')}</p>
          ) : null}
          {open === 'tokens' ? <p className="cu-note">{t('sm.tokensNote')}</p> : null}
        </Dialog>
      </Popover>
    </div>
  )
}
