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
  /** 锚点元素；在 `PopoverTrigger` 内使用时可不传，由 RAC 接管。 */
  triggerRef?: RefObject<Element | null>
  /** 覆盖列表来源；缺省自订阅 `useRunsV3` 的全部运行。 */
  runs?: readonly RunSnapshot[]
  /** 点某一行回到会话；不给则行不可点。 */
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

/**
 * 运行列表浮层（WP-14）。
 *
 * 与运行总览共用同一套排序（`sortRuns` → `compareRuns`），不推测 runner 阶段；
 * 每行只展示快照里真实存在的 code / title / model / status / tools / time，
 * 缺的显示「—」。上下文用量只读 `context.percent`，没有就不显示，绝不编一个额度。
 */
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

  /* 打开期间每 30 秒刷新一次「已持续」，关掉就停，不留定时器。 */
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
