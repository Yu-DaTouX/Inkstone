import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Square } from 'lucide-react'
import { Button, CollapsibleChevron, ConfirmDialog, IconButton, ListRow, Notice } from '../../ui'
import { useT } from '../../i18n'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../state/store'
import { viewSubagentRuns } from '../../state/subagent-view'
import { useThrottledValue } from '../../state/streaming-throttle'
import { useSubagentStopping } from '../../state/subagent-stopping'
import type { RunLang } from '../../state/runs-v3'
import { formatDuration } from '../../../../shared/duration'
import { buildSubagentTaskRow, isLiveSubagentRun, type SubagentTaskRow } from '../../../../shared/subagent-task-rows'
import type { SubagentRun } from '../../../../shared/ipc'
import { SubagentStateIcon } from '../session/SubagentState'
import { compactTaskPaths } from '../session/SubagentLine'
import { openSubagentPane, rowLang, stopSubagentChecked, useTicker } from '../session/subagent-actions'
import { turnModelLabel } from '../session/turn-model-label'
import {
  isLiveTaskRow,
  isNearBottom,
  sectionTasks,
  subagentOutputText,
  tailOutput,
  type BackgroundTaskEntry
} from './background-tasks'
import type { OverviewText } from './workbench-text'
import { terminalJobsForView, useTerminalJobs } from '../../state/terminal-jobs'
import { isLiveTerminalJob, type TerminalJob } from '../../../../shared/terminal-jobs'
import type { SubagentRowState } from '../../../../shared/subagent-task-rows'
import { openPanelTool } from './panel-actions'
import { activateTerminal } from '../terminal/terminal-activate'

type TaskEntry = BackgroundTaskEntry & { run: SubagentRun; row: SubagentTaskRow }
type JobEntry = BackgroundTaskEntry & { job: TerminalJob }

export function useViewTerminalJobs(): TerminalJob[] {
  const jobs = useTerminalJobs((s) => s.jobs)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore((s) => s.session)
  useEffect(() => {
    void useTerminalJobs.getState().load()
  }, [])
  return useMemo(() => terminalJobsForView(jobs, { peekedSessionId, peekedPath, session }), [jobs, peekedSessionId, peekedPath, session])
}

export interface BackgroundTasksProps {
  lang: RunLang
  text: OverviewText
}

export function BackgroundTasks({ lang, text }: BackgroundTasksProps): ReactElement {
  const latestSubagents = useStore(useShallow(viewSubagentRuns))
  const stopping = useSubagentStopping((s) => s.ids)
  const anyLive = latestSubagents.some(isLiveSubagentRun)
  const subagents = useThrottledValue(latestSubagents, anyLive)
  const terminalJobs = useViewTerminalJobs()
  const now = useTicker(anyLive || terminalJobs.some(isLiveTerminalJob))
  const entries = useMemo<TaskEntry[]>(() => {
    return subagents.map((run) => {
      const row = buildSubagentTaskRow(run, { now, lang: rowLang(lang), stopping: stopping.has(run.id) })
      return { id: run.id, live: isLiveTaskRow(row), startedAt: row.startedAt, endedAt: row.endedAt, run, row }
    })
  }, [subagents, now, lang, stopping])
  const jobEntries = useMemo<JobEntry[]>(
    () => terminalJobs.map((job) => ({ id: job.id, live: isLiveTerminalJob(job), startedAt: job.startedAt, endedAt: job.endedAt ?? null, job })),
    [terminalJobs]
  )
  const sections = sectionTasks<TaskEntry | JobEntry>([...entries, ...jobEntries])
  const [finishedOpen, setFinishedOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const t = useT()
  const finishedRunIds = sections.finished.map((entry) => entry.id)
  const finishedJobIds = sections.finished.filter((entry) => 'job' in entry).map((entry) => entry.id)
  const clearFinished = async (): Promise<void> => {
    try {
      if (finishedJobIds.length) await window.yan.terminal.clearJobs(finishedJobIds)
      await window.yan.subagents.clearFinished(finishedRunIds.filter((id) => !finishedJobIds.includes(id)))
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : String(failure))
    }
    await useStore.getState().loadSubagents()
  }

  const onGone = useCallback((): void => setNotice(text.taskGone), [text])

  return (
    <div className="wb-bg" data-testid="wb-bg-tasks">
      {sections.running.length > 0 ? (
        <section className="wb-bg-section" aria-label={text.runningSection(sections.running.length)} data-testid="wb-bg-running">
          <p className="wb-bg-section-title">{text.runningSection(sections.running.length)}</p>
          <ul className="wb-bg-list">
            {sections.running.map((entry) =>
              'job' in entry ? <JobRow key={entry.id} job={entry.job} now={now} text={text} onGone={onGone} /> : <TaskRow key={entry.id} entry={entry} now={now} text={text} onGone={onGone} />
            )}
          </ul>
        </section>
      ) : null}
      {sections.finished.length > 0 ? (
        <section className="wb-bg-section" data-testid="wb-bg-finished">
          <div className="wb-bg-section-head">
          <Button
            variant="ghost"
            size="sm"
            className="wb-bg-section-toggle"
            aria-expanded={finishedOpen}
            trailingIcon={<CollapsibleChevron expanded={finishedOpen} />}
            onPress={() => setFinishedOpen((open) => !open)}
            data-testid="wb-bg-finished-toggle"
          >
            {text.finishedSection(sections.finished.length)}
          </Button>
          {finishedRunIds.length ? (
            <Button variant="ghost" size="sm" className="wb-bg-clear" onPress={() => setConfirmClear(true)} data-testid="wb-bg-clear-finished">
              {t('sa.clearFinished')}
            </Button>
          ) : null}
          </div>
          {finishedOpen ? (
            <ul className="wb-bg-list">
              {sections.finished.map((entry) =>
                'job' in entry ? <JobRow key={entry.id} job={entry.job} now={now} text={text} onGone={onGone} /> : <TaskRow key={entry.id} entry={entry} now={now} text={text} onGone={onGone} />
              )}
            </ul>
          ) : null}
        </section>
      ) : null}
      {notice ? <Notice variant="hint" data-testid="wb-bg-notice">{notice}</Notice> : null}
      <ConfirmDialog
        isOpen={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('sa.clearFinished')}
        description={t('sa.clearFinishedConfirm')}
        confirmLabel={t('sa.clearFinished')}
        tone="danger"
        onConfirm={clearFinished}
        data-testid="wb-bg-clear-confirm"
      />
    </div>
  )
}

interface TaskRowProps {
  entry: TaskEntry
  now: number
  text: OverviewText
  onGone: () => void
}

const TaskRow = memo(
  TaskRowView,
  (a: TaskRowProps, b: TaskRowProps) =>
    a.now === b.now && a.text === b.text && a.onGone === b.onGone && a.entry.run === b.entry.run && a.entry.row.state === b.entry.row.state
)

function TaskRowView({ entry, text, onGone }: TaskRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const models = useStore((s) => s.models)

  const { run, row } = entry
  if (!entry.live) return (
    <li className="wb-bg-row" data-state={row.state} data-testid="wb-bg-row">
      <div className="wb-bg-line">
        <ListRow className="wb-bg-open" icon={<SubagentStateIcon state={row.state} />} title={run.task} onClick={() => openSubagentPane(run.id)} data-testid="wb-bg-open">
          <span className="wb-bg-label">{compactTaskPaths(run.brief?.title || row.description)}</span>
        </ListRow>
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
        <ListRow className="wb-bg-open" icon={<SubagentStateIcon state={row.state} />} trailing={time || undefined} title={run.task} onClick={() => openSubagentPane(run.id)} data-testid="wb-bg-open">
          <span className="wb-bg-label">{label}</span>
        </ListRow>
        {output ? (
          <IconButton size="sm" aria-label={open ? text.hideOutput : text.showOutput} tooltip={open ? text.hideOutput : text.showOutput} aria-expanded={open} onPress={() => setOpen((value) => !value)} data-testid="wb-bg-output-toggle">
            <CollapsibleChevron expanded={open} />
          </IconButton>
        ) : null}
        {row.canStop || row.state === 'stopping' ? (
          <IconButton size="sm" aria-label={text.stopTask} tooltip={text.stopTask} isDisabled={row.state === 'stopping'} onPress={() => void stop()} data-testid="wb-bg-stop">
            <Square size={12} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {detail ? <p className="wb-bg-detail" title={detail}>{detail}</p> : null}
      {open && output ? <TaskOutput text={output} earlier={text.earlierOutput} label={label} /> : null}
    </li>
  )
}

const JOB_ROW_STATE: Record<TerminalJob['state'], SubagentRowState> = {
  running: 'running',
  stopping: 'stopping',
  completed: 'done',
  matched: 'done',
  exited: 'stopped',
  timeout: 'failed',
  stopped: 'stopped'
}

function JobRow({ job, now, text, onGone }: { job: TerminalJob; now: number; text: OverviewText; onGone: () => void }): ReactElement {
  const live = isLiveTerminalJob(job)
  const time = formatDuration(Math.max(0, (job.endedAt ?? now) - job.startedAt), { minSeconds: 1 })
  const detail = [text.terminalJobState[job.state], job.cwd.split(/[\\/]/).filter(Boolean).pop()].filter(Boolean).join(' · ')
  const open = (): void => {
    if (job.kind === 'bash') return
    const owner = job.owners[0]
    openPanelTool('terminal')
    if (owner) activateTerminal(owner, job.terminalId)
  }
  const stop = async (): Promise<void> => {
    try {
      if (!(await window.yan.terminal.stopJob(job.id))) onGone()
    } catch {
      useStore.getState().notify('error', text.stopFailed)
    }
  }
  return (
    <li className="wb-bg-row" data-state={JOB_ROW_STATE[job.state]} data-testid="wb-bg-row">
      <div className="wb-bg-line">
        <ListRow className="wb-bg-open" icon={<SubagentStateIcon state={JOB_ROW_STATE[job.state]} />} trailing={live ? time : undefined} title={job.command} onClick={open} data-testid="wb-bg-open">
          <span className="wb-bg-label">{job.command}</span>
        </ListRow>
        {live ? (
          <IconButton size="sm" aria-label={text.stopTask} tooltip={text.stopTask} isDisabled={job.state === 'stopping'} onPress={() => void stop()} data-testid="wb-bg-stop">
            <Square size={12} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {live ? <p className="wb-bg-detail" title={detail}>{detail}</p> : null}
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
