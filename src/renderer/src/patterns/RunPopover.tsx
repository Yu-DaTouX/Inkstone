import { useEffect, useMemo, useState, type ReactElement, type RefObject } from 'react'
import { Dialog, Popover } from 'react-aria-components'
import type { RunSnapshot } from '../../../shared/runs'
import { useI18n } from '../i18n'
import {
  contextPercent,
  isUnreadRun,
  kindWord,
  modelLabel,
  phaseWord,
  runTimeText,
  runTone,
  runUiText,
  sortRuns,
  toolSummary,
  type RunLang,
  type RunUiText
} from '../state/runs-v3'
import { useRunsV3 } from '../state/runs-v3'
import { RunDot } from './RunDot'
import './run-status.css'

export interface RunPopoverProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  triggerRef?: RefObject<Element | null>
  runs?: readonly RunSnapshot[]
  onOpenSession?: (run: RunSnapshot) => void
  placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end'
  className?: string
}

const dash = (value: string | null | undefined, none: string): string => (value && value.trim() ? value : none)

function subtitle(lang: RunLang, run: RunSnapshot, t: RunUiText): string {
  const parts: string[] = [modelLabel(run) ?? t.none, kindWord(lang, run.kind)]
  const tools = toolSummary(lang, run)
  if (tools) parts.push(tools)
  const ctx = contextPercent(run)
  if (ctx !== null) parts.push(`${t.fieldContext} ${Math.round(ctx)}%`)
  return parts.join(' · ')
}

function PopoverRow({
  run,
  lang,
  now,
  text,
  onOpenSession
}: {
  run: RunSnapshot
  lang: RunLang
  now: number
  text: RunUiText
  onOpenSession?: (run: RunSnapshot) => void
}): ReactElement {
  const title = dash(run.title, text.untitled)
  const body = (
    <>
      <RunDot phase={run.phase} code={run.code} unread={isUnreadRun(run)} />
      <span className="run-pop-headline">
        <span className="run-pop-code">{run.code}</span>
        <span className="run-pop-name">{title}</span>
      </span>
      <span className="run-pop-status">{phaseWord(lang, run.phase)}</span>
      <span className="run-pop-meta">
        <span>{subtitle(lang, run, text)}</span>
      </span>
      <span className="run-pop-time">{runTimeText(lang, run, now)}</span>
    </>
  )
  if (onOpenSession) {
    return (
      <button
        type="button"
        className="run-pop-row"
        onClick={() => onOpenSession(run)}
        title={`${run.code} · ${title}`}
      >
        {body}
      </button>
    )
  }
  return (
    <div className="run-pop-row" data-tone={runTone(run.phase)}>
      {body}
    </div>
  )
}

export function RunPopover({
  isOpen,
  onOpenChange,
  triggerRef,
  runs,
  onOpenSession,
  placement = 'bottom end',
  className
}: RunPopoverProps): ReactElement {
  const { lang } = useI18n()
  const text = runUiText(lang)
  const storeRuns = useRunsV3((s) => s.runs)
  const source = runs ?? storeRuns
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isOpen) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [isOpen])

  const list = useMemo(() => sortRuns(source), [source])

  return (
    <Popover
      className={`run-pop ${className ?? ''}`.trim()}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      {...(triggerRef ? { triggerRef } : {})}
      placement={placement}
      offset={8}
    >
      <Dialog className="run-pop-dialog" aria-label={text.runsTitle}>
        <div className="run-pop-head">
          <h3 className="run-pop-title">{text.runsTitle}</h3>
          <span className="run-pop-count">{list.length}</span>
        </div>
        {list.length === 0 ? (
          <p className="run-pop-empty">{text.runsEmpty}</p>
        ) : (
          <ul className="run-pop-list">
            {list.map((run) => (
              <li key={run.runId}>
                <PopoverRow run={run} lang={lang} now={now} text={text} onOpenSession={onOpenSession} />
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </Popover>
  )
}
