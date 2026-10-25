import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Square } from 'lucide-react'
import { Button, IconButton, StatusDot, StatusSlot } from '../../ui'
import { useStore } from '../../state/store'
import { useSubagentStopping } from '../../state/subagent-stopping'
import { phaseWord, runTone, type RunLang } from '../../state/runs-v3'
import { formatDuration } from '../../../../shared/duration'
import { buildSubagentTaskRow, type SubagentTaskRow } from '../../../../shared/subagent-task-rows'
import type { RunSnapshot } from '../../../../shared/runs'
import type { SubagentRun } from '../../../../shared/ipc'
import { SubagentStateIcon } from '../session/SubagentState'
import { compactTaskPaths } from '../session/SubagentLine'
import { openSubagentPane, rowLang, stopSubagentChecked, useTicker } from '../session/subagent-actions'
import { turnModelLabel } from '../session/turn-model-label'
import {
  canStopRun,
  isLiveTaskRow,
  isNearBottom,
  runEndedAt,
  sectionTasks,
  subagentOutputText,
  tailOutput,
  type BackgroundTaskEntry
} from './background-tasks'
import type { OverviewText } from './workbench-text'

type TaskEntry =
  | (BackgroundTaskEntry & { kind: 'subagent'; run: SubagentRun; row: SubagentTaskRow })
  | (BackgroundTaskEntry & { kind: 'scheduled'; snapshot: RunSnapshot })

export interface BackgroundTasksProps {
  subagents: readonly SubagentRun[]
  scheduled: readonly RunSnapshot[]
  lang: RunLang
  text: OverviewText
}

export function backgroundTaskCount(subagents: readonly SubagentRun[], scheduled: readonly RunSnapshot[], stopping: ReadonlySet<string>, now: number): { running: number; total: number } {
  const running =
    subagents.filter((run) => isLiveTaskRow(buildSubagentTaskRow(run, { now, stopping: stopping.has(run.id) }))).length +
    scheduled.filter(canStopRun).length
  return { running, total: subagents.length + scheduled.length }
}

export function BackgroundTasks({ subagents, scheduled, lang, text }: BackgroundTasksProps): ReactElement {
  const stopping = useSubagentStopping((s) => s.ids)
  const anyLive = subagents.some((run) => run.status === 'starting' || run.status === 'running') || scheduled.some(canStopRun)
  const now = useTicker(anyLive)
  const entries = useMemo<TaskEntry[]>(() => {
    const agentEntries: TaskEntry[] = subagents.map((run) => {
      const row = buildSubagentTaskRow(run, { now, lang: rowLang(lang), stopping: stopping.has(run.id) })
      return { id: run.id, kind: 'subagent', live: isLiveTaskRow(row), startedAt: row.startedAt, endedAt: row.endedAt, run, row }
    })
    const runEntries: TaskEntry[] = scheduled.map((snapshot) => ({
      id: snapshot.runId,
      kind: 'scheduled',
      live: canStopRun(snapshot),
      startedAt: snapshot.startedAt,
      endedAt: runEndedAt(snapshot.phase),
      snapshot
    }))
    return [...agentEntries, ...runEntries]
  }, [subagents, scheduled, now, lang, stopping])
  const sections = sectionTasks(entries)
  const [finishedOpen, setFinishedOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const onGone = (): void => setNotice(text.taskGone)

  return (
    <div className="wb-bg" data-testid="wb-bg-tasks">
      {sections.running.length > 0 ? (
        <section className="wb-bg-section" aria-label={text.runningSection(sections.running.length)} data-testid="wb-bg-running">
          <p className="wb-bg-section-title">{text.runningSection(sections.running.length)}</p>
          <ul className="wb-bg-list">
            {sections.running.map((entry) => (
              <TaskRow key={entry.id} entry={entry} now={now} lang={lang} text={text} onGone={onGone} />
            ))}
          </ul>
        </section>
      ) : null}
      {sections.finished.length > 0 ? (
        <section className="wb-bg-section" data-testid="wb-bg-finished">
          <Button
            variant="ghost"
            size="sm"
            className="wb-bg-section-toggle"
            aria-expanded={finishedOpen}
            trailingIcon={finishedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            onPress={() => setFinishedOpen((open) => !open)}
            data-testid="wb-bg-finished-toggle"
          >
            {text.finishedSection(sections.finished.length)}
          </Button>
          {finishedOpen ? (
            <ul className="wb-bg-list">
              {sections.finished.map((entry) => (
                <TaskRow key={entry.id} entry={entry} now={now} lang={lang} text={text} onGone={onGone} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {notice ? <p className="wb-bg-notice" role="status" data-testid="wb-bg-notice">{notice}</p> : null}
    </div>
  )
}

const RUN_DOT = { run: 'running', ask: 'awaiting', stall: 'awaiting', fail: 'fail', done: 'ok', idle: 'idle' } as const

function TaskRow({ entry, now, lang, text, onGone }: { entry: TaskEntry; now: number; lang: RunLang; text: OverviewText; onGone: () => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const [stoppingRun, setStoppingRun] = useState(false)
  const models = useStore((s) => s.models)

  if (entry.kind === 'subagent') {
    const { run, row } = entry
    if (!entry.live) return (
      <li className="wb-bg-row" data-state={row.state} data-testid="wb-bg-row">
        <div className="wb-bg-line">
          <Button variant="ghost" size="sm" className="wb-bg-main" title={run.task} onPress={() => openSubagentPane(run.id)} data-testid="wb-bg-open">
            <SubagentStateIcon state={row.state} />
            <span className="wb-bg-label">{compactTaskPaths(run.brief?.title || row.description)}</span>
          </Button>
        </div>
      </li>
    )
    const label = compactTaskPaths(row.label)
    const time = row.durationMs === null ? '' : formatDuration(row.durationMs, { minSeconds: 1 })
    const modelName = run.model ? turnModelLabel(run.model, models).label : ''
    const detail = entry.live ? [row.latestActivity, modelName].filter(Boolean).join(' · ') : row.summaryLine ?? modelName
    const output = subagentOutputText(run)
    const stop = async (): Promise<void> => {
      try {
        if ((await stopSubagentChecked(run.id)) === 'gone') onGone()
      } catch {
        useStore.getState().notify('error', text.stopFailed)
      }
    }
    return (
      <li className="wb-bg-row" data-state={row.state} data-testid="wb-bg-row">
        <div className="wb-bg-line">
          <Button variant="ghost" size="sm" className="wb-bg-main" title={run.task} onPress={() => openSubagentPane(run.id)} data-testid="wb-bg-open">
            <SubagentStateIcon state={row.state} />
            <span className="wb-bg-label">{label}</span>
            <span className="wb-bg-time">{time}</span>
          </Button>
          {output ? (
            <IconButton size="sm" aria-label={open ? text.hideOutput : text.showOutput} aria-expanded={open} onPress={() => setOpen((value) => !value)} data-testid="wb-bg-output-toggle">
              {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </IconButton>
          ) : null}
          {row.canStop || row.state === 'stopping' ? (
            <IconButton size="sm" aria-label={text.stopTask} isDisabled={row.state === 'stopping'} onPress={() => void stop()} data-testid="wb-bg-stop">
              <Square size={11} aria-hidden />
            </IconButton>
          ) : null}
        </div>
        {detail ? <p className="wb-bg-detail">{detail}</p> : null}
        {open && output ? <TaskOutput text={output} earlier={text.earlierOutput} label={label} /> : null}
      </li>
    )
  }

  const { snapshot } = entry
  const tone = runTone(snapshot.phase)
  const ended = runEndedAt(snapshot.phase)
  const time = formatDuration(Math.max(0, (ended ?? now) - snapshot.startedAt), { minSeconds: 1 })
  const stop = async (): Promise<void> => {
    setStoppingRun(true)
    try {
      const fresh = await window.yan.runs.snapshot().catch(() => null)
      const current = fresh?.runs.find((item) => item.runId === snapshot.runId)
      if (!current || !canStopRun(current)) {
        onGone()
        return
      }
      const result = await window.yan.runs.stop(snapshot.runId)
      if (!result.ok) useStore.getState().notify('error', result.error ? `${text.stopFailed}：${result.error}` : text.stopFailed)
    } catch {
      useStore.getState().notify('error', text.stopFailed)
    } finally {
      setStoppingRun(false)
    }
  }
  return (
    <li className="wb-bg-row" data-state={snapshot.phase.kind} data-testid="wb-bg-row">
      <div className="wb-bg-line">
        <span className="wb-bg-main wb-bg-static" title={`${snapshot.code} ${snapshot.title}`}>
          <StatusSlot>
            <StatusDot kind={RUN_DOT[tone]} />
          </StatusSlot>
          <span className="wb-bg-label">{snapshot.title || snapshot.code}</span>
          {entry.live ? <span className="wb-bg-time">{time}</span> : null}
        </span>
        {entry.live ? (
          <IconButton size="sm" aria-label={text.stopTask} isDisabled={stoppingRun} onPress={() => void stop()} data-testid="wb-bg-stop">
            <Square size={11} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {entry.live ? <p className="wb-bg-detail">{`${text.scheduledKind} · ${phaseWord(lang, snapshot.phase)}`}</p> : null}
    </li>
  )
}

function selectionInside(el: HTMLElement): boolean {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && el.contains(selection.anchorNode)
}

function TaskOutput({ text, earlier, label }: { text: string; earlier: string; label: string }): ReactElement {
  const tail = tailOutput(text)
  const ref = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && follow.current && !selectionInside(el)) el.scrollTop = el.scrollHeight
  }, [tail.text])
  useEffect(() => {
    follow.current = true
  }, [label])
  return (
    <pre
      ref={ref}
      className="wb-bg-output"
      tabIndex={0}
      aria-label={label}
      onScroll={(event) => {
        follow.current = isNearBottom(event.currentTarget)
      }}
      data-testid="wb-bg-output"
    >
      {tail.clipped ? <span className="wb-bg-earlier">{`${earlier}\n`}</span> : null}
      {tail.text}
    </pre>
  )
}
