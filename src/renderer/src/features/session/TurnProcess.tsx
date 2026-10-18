import { useState, type JSX, type ReactNode } from 'react'
import { useI18n, useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import { ToolSteps } from './ToolSteps'
import { Button } from '../../ui'
import { useSessionText } from './text'
import { generatingArgs, summarize } from './tool-summary'
import { narrationLine, pickLiveSegments, processNotes, processSummaryLabel, processTools, runningTool } from './turn-process'

function mergeQuietSegments(process: readonly TurnSegment[]): TurnSegment[] {
  const merged: TurnSegment[] = []
  for (const segment of process) {
    const previous = merged[merged.length - 1]
    if (previous && !segment.commentary.length && previous.tools.length && segment.tools.length) {
      merged[merged.length - 1] = { ...previous, tools: [...previous.tools, ...segment.tools] }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

export function TurnProcess({ process, elapsedMs, live, thinking, sessionId }: {
  process: TurnSegment[]
  elapsedMs?: number
  live: boolean
  thinking?: ReactNode
  sessionId: string | null
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const zh = useI18n().lang !== 'en-US'
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? live

  const tools = processTools(process)
  const notes = processNotes(process)
  const current = live ? runningTool(tools) : null
  const summary = processSummaryLabel(tools, zh, t('proc.title'))
  const latest = notes.length ? narrationLine(notes[notes.length - 1]) : ''
  const label = current
    ? `${current.name} ${generatingArgs(current) ? t('tool2.generatingArgs') : summarize(current)}`.trim()
    : live && latest && !open
      ? latest
      : summary
  const time = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null
  const merged = mergeQuietSegments(process)
  const { shown: groups, hidden } = open && live && manual === null ? pickLiveSegments(merged) : { shown: merged, hidden: 0 }

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
          {hidden > 0 ? (
            <Button size="sm" variant="ghost" className="v3-process-more" onPress={() => setManual(true)} data-testid="v3-process-more">
              {tt('moreItems', { n: hidden })}
            </Button>
          ) : null}
          {groups.map((segment) => (
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
