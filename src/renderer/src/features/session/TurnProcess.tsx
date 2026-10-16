/**
 * 一轮回复的「过程行」：把回复之前的旁白、工具组（与推理）收成一行。
 *
 * 外观复用 ToolSteps 的摘要行（同字号、同 chevron）；默认折叠，用户展开后在本次
 * 挂载内保持。运行中只显示一行：当前正在运行的工具，否则最新一句旁白。
 * 展开后按原顺序铺开旁白（弱化）与各工具组（沿用 ToolSteps 的渲染）。
 */
import { useState, type JSX, type ReactNode } from 'react'
import { useI18n, useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import { ToolSteps } from './ToolSteps'
import { summarize } from './tool-summary'
import { narrationLine, processNotes, processSummaryLabel, processTools, runningTool } from './turn-process'

export function TurnProcess({ process, elapsedMs, live, thinking, sessionId }: {
  process: TurnSegment[]
  /** 整轮墙钟用时；运行中不显示（运行行自己有计时） */
  elapsedMs?: number
  /** 运行中：标签取当前工具或最新旁白，不逐段铺开 */
  live: boolean
  /** 推理块：只在完成后放进过程行内部 */
  thinking?: ReactNode
  sessionId: string | null
}): JSX.Element {
  const t = useT()
  const zh = useI18n().lang !== 'en-US'
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? false

  const tools = processTools(process)
  const notes = processNotes(process)
  const current = live ? runningTool(tools) : null
  const summary = processSummaryLabel(tools, zh, t('proc.title'))
  const latest = notes.length ? narrationLine(notes[notes.length - 1]) : ''
  const label = current
    ? `${current.name} ${summarize(current)}`.trim()
    : live && latest
      ? latest
      : summary
  const time = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null

  return (
    <section className="v3-steps v3-process" data-testid="v3-process" aria-label={t('proc.title')}>
      <button
        className="v3-steps-sum v3-process-sum"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        data-testid="v3-process-toggle"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="v3-chev" />
        <span className="v3-steps-label v3-process-label" title={label}>{label}</span>
        {time ? <span className="v3-act-time v3-process-time">{time}</span> : null}
      </button>

      {open ? (
        <div className="v3-process-body" data-testid="v3-process-body">
          {thinking}
          {process.map((segment) => (
            <div key={segment.id} className="v3-process-seg">
              {segment.commentary.length ? (
                <div className="v3-process-notes">
                  {segment.commentary.map((part) => (
                    <div key={part.id} className="v3-process-note">
                      <Markdown text={part.text} sourceCwd={part.sourceCwd} live={false} sessionId={sessionId} messageId={part.id} />
                    </div>
                  ))}
                </div>
              ) : null}
              <ToolSteps tools={segment.tools} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
