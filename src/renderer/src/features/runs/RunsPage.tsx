import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { RunKind, RunSnapshot } from '../../../../shared/runs'
import type { RunsHistoryRecord, RunsHistoryResult } from '../../../../shared/ipc'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import {
  formatDuration,
  formatRelative,
  isUnreadRun,
  kindWord,
  modelLabel,
  phaseDetail,
  phaseWord,
  runTimeText,
  runTone,
  runUiText,
  sortRuns,
  toolSummary,
  useRunsV3
} from '../../state/runs-v3'
import { RunDot } from '../../patterns/RunDot'
import { Button, Checkbox, Dialog, ListBoxItem, Modal, ModalOverlay, SearchField, Select } from '../../ui'
import type { RunLang } from '../../state/runs-v3'
import { RunsTimeline } from './RunsTimeline'
import { RunsUsage } from './RunsUsage'
import type { DayTimelineLane } from './runs-timeline-model'
import {
  RUNS_FILTER_ALL,
  RUNS_STATUS_FILTERS,
  clearRunsFilter,
  collectKindOptions,
  collectModelOptions,
  collectProjectOptions,
  filterHistoryRecords,
  filterLiveRuns,
  hasActiveFilters,
  isStoppableRun,
  type RunsFilter,
  type RunsStatusFilter
} from './runs-filter-model'
import './runs-page.css'

export { isStoppableRun }

export interface RunsPageProps {
  onOpenSession?: (path: string) => void
}

function dayString(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function todayString(): string {
  return dayString(new Date())
}

function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const at = new Date(year, (month || 1) - 1, date || 1, 12, 0, 0, 0)
  at.setDate(at.getDate() + delta)
  return dayString(at)
}

interface PageText {
  filterLabel: string
  filterProject: string
  filterModel: string
  filterKind: string
  allProjects: string
  allModels: string
  allKinds: string
  searchLabel: string
  searchPlaceholder: string
  clearFilters: string
  noMatch: string
  filters: Record<RunsStatusFilter, string>
  selectAll: string
  selectRun: string
  stopSelected: string
  stopConfirmTitle: string
  stopConfirmBody: string
  stopConfirm: string
  stopCancel: string
  stopResult: (ok: number, fail: number) => string
  stopUnsupported: string
  channelUnavailable: string
  recoveredTitle: string
  recoveredNotice: string
  recoveredCopy: string
  recoveredClose: string
  historyTitle: string
  historyToday: string
  historyPrev: string
  historyNext: string
  historyEmpty: string
  historyLoading: string
  historyLoadError: string
  runCount: (count: number) => string
  waitingSubagent: string
  views: { timeline: string; list: string }
  duration: string
  timeline: string
  terminal: Record<RunsHistoryRecord['terminal'], string>
}

function pageText(lang: RunLang): PageText {
  if (lang === 'en-US') {
    return {
      filterLabel: 'Filter by status',
      filterProject: 'Filter by project',
      filterModel: 'Filter by model',
      filterKind: 'Filter by kind',
      allProjects: 'All projects',
      allModels: 'All models',
      allKinds: 'All kinds',
      searchLabel: 'Search runs',
      searchPlaceholder: 'Search code, title or model',
      clearFilters: 'Clear filters',
      noMatch: 'No runs match the current filters.',
      filters: { all: 'All', attention: 'Needs attention', active: 'Running', done: 'Done', stopped: 'Stopped' },
      selectAll: 'Select all running',
      selectRun: 'Select this run',
      stopSelected: 'Stop selected',
      stopConfirmTitle: 'Stop selected runs',
      stopConfirmBody: 'The selected runs will be stopped the same way the Stop button does it. Queued text you typed is returned to the session input. Continue?',
      stopConfirm: 'Stop',
      stopCancel: 'Cancel',
      stopResult: (ok, fail) => (fail ? `Stopped ${ok}, ${fail} failed` : `Stopped ${ok}`),
      stopUnsupported: 'This run kind can’t be stopped here',
      channelUnavailable: 'Run control channel unavailable',
      recoveredTitle: 'Recovered queued messages',
      recoveredNotice: 'Queued messages were recovered but not sent. Copy anything you still need.',
      recoveredCopy: 'Copy',
      recoveredClose: 'Close',
      historyTitle: 'History',
      historyToday: 'Today',
      historyPrev: 'Previous day',
      historyNext: 'Next day',
      historyEmpty: 'No runs recorded on this day.',
      historyLoading: 'Loading history…',
      historyLoadError: 'Failed to load run history',
      runCount: (count) => `${count} run${count === 1 ? '' : 's'}`,
      waitingSubagent: 'Waiting on subagent',
      views: { timeline: 'Timeline', list: 'List' },
      duration: 'Duration',
      timeline: 'Timeline',
      terminal: { done: 'Done', stopped: 'Stopped', failed: 'Failed' }
    }
  }
  return {
    filterLabel: '按状态筛选',
    filterProject: '按项目筛选',
    filterModel: '按模型筛选',
    filterKind: '按类型筛选',
    allProjects: '全部项目',
    allModels: '全部模型',
    allKinds: '全部类型',
    searchLabel: '搜索运行',
    searchPlaceholder: '搜索编号、标题或模型',
    clearFilters: '清除筛选',
    noMatch: '没有符合当前筛选的运行。',
    filters: { all: '全部', attention: '需要处理', active: '运行中', done: '已完成', stopped: '已停止' },
    selectAll: '全选运行中',
    selectRun: '选择这次运行',
    stopSelected: '停止选中',
    stopConfirmTitle: '停止选中的运行',
    stopConfirmBody: '选中的运行会按与「停止」按钮相同的路径停止；你排队的文字会退回会话输入框。确定继续？',
    stopConfirm: '停止',
    stopCancel: '取消',
    stopResult: (ok, fail) => (fail ? `已停止 ${ok}，${fail} 个未停` : `已停止 ${ok}`),
    stopUnsupported: '这种运行暂不支持在这里停止',
    channelUnavailable: '运行控制通道不可用',
    recoveredTitle: '已取回排队消息',
    recoveredNotice: '排队消息已取回，未发送。请复制仍需要的内容。',
    recoveredCopy: '复制',
    recoveredClose: '关闭',
    historyTitle: '历史',
    historyToday: '今天',
    historyPrev: '前一天',
    historyNext: '后一天',
    historyEmpty: '这一天没有运行记录。',
    historyLoading: '正在读取运行历史…',
    historyLoadError: '运行历史读取失败',
    runCount: (count) => `共 ${count} 项`,
    waitingSubagent: '等待子 Agent',
    views: { timeline: '时间线', list: '列表' },
    duration: '用时',
    timeline: '时间线',
    terminal: { done: '已完成', stopped: '已停止', failed: '失败' }
  }
}

function historyToolSummary(record: RunsHistoryRecord, lang: RunLang): string {
  const { tools, edits, errors } = record.counts
  if (lang === 'en-US') {
    const parts = [`${tools} tool${tools === 1 ? '' : 's'}`]
    if (edits) parts.push(`${edits} edit${edits === 1 ? '' : 's'}`)
    if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }
  const parts = [`工具 ${tools}`]
  if (edits) parts.push(`改动 ${edits}`)
  if (errors) parts.push(`错误 ${errors}`)
  return parts.join(' · ')
}

function HistoryTimeline({ record, lang }: { record: RunsHistoryRecord; lang: RunLang }): ReactElement {
  const total = Math.max(1, record.endedAt - record.startedAt)
  const segments = record.segments.length
    ? record.segments
    : [{ phase: record.terminal, from: record.startedAt, to: record.endedAt }]
  return (
    <span className="runs-timeline" aria-hidden="true">
      {segments.map((segment, index) => {
        const width = Math.max(2, Math.min(100, ((segment.to - segment.from) / total) * 100))
        return (
          <span
            key={`${segment.phase}-${index}`}
            className="runs-timeline-seg"
            data-phase={segment.phase}
            style={{ width: `${width}%` }}
            title={`${segment.phase} · ${formatDuration(Math.max(0, segment.to - segment.from), lang)}`}
          />
        )
      })}
    </span>
  )
}

export function RunsPage({ onOpenSession }: RunsPageProps = {}): ReactElement {
  const { lang } = useI18n()
  const text = runUiText(lang)
  const page = pageText(lang)
  const runs = useRunsV3((s) => s.runs)
  const syncing = useRunsV3((s) => s.syncing)
  const error = useRunsV3((s) => s.error)
  const requestMarkSeen = useRunsV3((s) => s.requestMarkSeen)
  const sessions = useStore((s) => s.sessions)
  const settingsProjects = useStore((s) => s.settings?.projects)
  const switchSession = useStore((s) => s.switchSession)
  const abort = useStore((s) => s.abort)
  const currentSessionId = useStore((s) => s.session?.sessionId)
  const [now, setNow] = useState(() => Date.now())
  const [filter, setFilter] = useState<RunsFilter>(() => clearRunsFilter())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopSummary, setStopSummary] = useState<string | null>(null)
  const [recoveredGroups, setRecoveredGroups] = useState<{ code: string; texts: string[] }[]>([])
  const [recoveredOpen, setRecoveredOpen] = useState(false)
  const [historyDay, setHistoryDay] = useState(todayString)
  const [historyView, setHistoryView] = useState<'timeline' | 'list'>('timeline')
  const [history, setHistory] = useState<RunsHistoryResult | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  useEffect(() => {
    const hasActive = runs.some((run) => isStoppableRun(run))
    if (!hasActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [runs])

  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    const bridge = window.yan?.runs
    if (!bridge || typeof bridge.history !== 'function') {
      setHistory(null)
      setHistoryError('运行历史通道不可用')
      setHistoryLoading(false)
      return
    }
    void bridge
      .history({ date: historyDay, limit: 200 })
      .then((result) => {
        if (cancelled) return
        if (!result?.ok) throw new Error(result?.error || 'history failed')
        setHistory(result)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setHistoryError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [historyDay])

  const list = useMemo(() => sortRuns(filterLiveRuns(runs, filter)), [runs, filter])
  const historyRows = useMemo(() => filterHistoryRecords(history?.records ?? [], filter), [history, filter])
  const selectable = useMemo(() => list.filter(isStoppableRun), [list])
  const projectOptions = useMemo(
    () => collectProjectOptions(runs, history?.records ?? [], settingsProjects ?? []),
    [runs, history, settingsProjects]
  )
  const modelOptions = useMemo(() => collectModelOptions(runs, history?.records ?? []), [runs, history])
  const kindOptions = useMemo(() => collectKindOptions(runs, history?.records ?? []), [runs, history])
  const filtersActive = hasActiveFilters(filter)
  const selectedActive = useMemo(
    () => selectable.filter((run) => selected.has(run.runId)),
    [selectable, selected]
  )
  const allSelected = selectable.length > 0 && selectedActive.length === selectable.length
  const someSelected = selectedActive.length > 0 && !allSelected

  const toggle = useCallback((runId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }, [])

  const patchFilter = useCallback((patch: Partial<RunsFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch }))
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const visible = selectable.map((run) => run.runId)
      const allOn = visible.length > 0 && visible.every((id) => prev.has(id))
      return allOn ? new Set() : new Set(visible)
    })
  }, [selectable])

  const runStop = useCallback(async () => {
    setConfirmOpen(false)
    if (!selectedActive.length) return
    setStopping(true)
    setStopSummary(null)
    const bridge = window.yan?.runs
    if (!bridge || typeof bridge.stop !== 'function') {
      setStopping(false)
      setStopSummary(page.channelUnavailable)
      return
    }
    let ok = 0
    const failures: string[] = []
    const loose: { code: string; texts: string[] }[] = []
    for (const run of selectedActive) {
      if (run.kind === 'session' && currentSessionId && run.sessionId === currentSessionId) {
        try {
          await abort()
          ok += 1
        } catch (reason) {
          failures.push(`${run.code}：${reason instanceof Error ? reason.message : String(reason)}`)
        }
        continue
      }
      try {
        const result = await bridge.stop(run.runId)
        if (result?.ok) {
          ok += 1
          const texts = [...(result.recovered?.steering ?? []), ...(result.recovered?.followUp ?? [])].filter(Boolean)
          if (texts.length) loose.push({ code: run.code, texts })
        } else {
          failures.push(`${run.code}：${result?.error ?? page.stopUnsupported}`)
        }
      } catch (reason) {
        failures.push(`${run.code}：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    setStopping(false)
    setSelected(new Set())
    setStopSummary(
      failures.length
        ? `${page.stopResult(ok, failures.length)} · ${failures.join('；')}`
        : page.stopResult(ok, 0)
    )
    if (loose.length) {
      setRecoveredGroups(loose)
      setRecoveredOpen(true)
    }
  }, [page, selectedActive, currentSessionId, abort])

  const open = (run: RunSnapshot): void => {
    if (isUnreadRun(run)) requestMarkSeen(run.runId)
    const path = run.sessionPath ?? sessions.find((s) => s.id === run.sessionId)?.path
    if (!path) return
    if (onOpenSession) onOpenSession(path)
    else void switchSession(path)
  }

  const openLane = (lane: DayTimelineLane): void => {
    if (lane.kind === 'subagent' && lane.sessionId.startsWith('subagent:')) {
      useStore.getState().openSubagent(lane.sessionId.slice('subagent:'.length))
    }
    const parent = lane.parentRunId
      ? history?.records.find((record) => record.runId === lane.parentRunId) ??
        runs.find((run) => run.runId === lane.parentRunId)
      : undefined
    const path =
      lane.sessionPath ??
      parent?.sessionPath ??
      sessions.find((s) => s.id === lane.sessionId)?.path
    if (!path) return
    if (onOpenSession) onOpenSession(path)
    else void switchSession(path)
  }

  const openKind = (kind: RunKind): string => kindWord(lang, kind)

  return (
    <section className="runs-page" aria-label={text.runsTitle}>
      <div className="runs-page-head">
        <h2 className="runs-page-title">{text.runsTitle}</h2>
        <span className="runs-page-count">{page.runCount(list.length)}</span>
      </div>

      <div className="runs-toolbar">
        <div className="runs-filters">
          <Select
            className="runs-filter"
            aria-label={page.filterLabel}
            selectedKey={filter.status}
            onSelectionChange={(key) =>
              patchFilter({ status: (String(key ?? RUNS_FILTER_ALL) || RUNS_FILTER_ALL) as RunsStatusFilter })
            }
          >
            {RUNS_STATUS_FILTERS.map((key) => (
              <ListBoxItem key={key} id={key}>
                {page.filters[key]}
              </ListBoxItem>
            ))}
          </Select>
          {kindOptions.length > 1 ? (
            <Select
              className="runs-filter"
              aria-label={page.filterKind}
              selectedKey={filter.kind}
              onSelectionChange={(key) =>
                patchFilter({ kind: String(key ?? RUNS_FILTER_ALL) as RunKind | typeof RUNS_FILTER_ALL })
              }
            >
              <ListBoxItem key={RUNS_FILTER_ALL} id={RUNS_FILTER_ALL}>
                {page.allKinds}
              </ListBoxItem>
              {kindOptions.map((kind) => (
                <ListBoxItem key={kind} id={kind}>
                  {openKind(kind)}
                </ListBoxItem>
              ))}
            </Select>
          ) : null}
          {projectOptions.length > 0 ? (
            <Select
              className="runs-filter"
              aria-label={page.filterProject}
              selectedKey={filter.projectId}
              onSelectionChange={(key) => patchFilter({ projectId: String(key ?? RUNS_FILTER_ALL) })}
            >
              <ListBoxItem key={RUNS_FILTER_ALL} id={RUNS_FILTER_ALL}>
                {page.allProjects}
              </ListBoxItem>
              {projectOptions.map((option) => (
                <ListBoxItem key={option.id} id={option.id}>
                  {option.label}
                </ListBoxItem>
              ))}
            </Select>
          ) : null}
          {modelOptions.length > 0 ? (
            <Select
              className="runs-filter"
              aria-label={page.filterModel}
              selectedKey={filter.modelId}
              onSelectionChange={(key) => patchFilter({ modelId: String(key ?? RUNS_FILTER_ALL) })}
            >
              <ListBoxItem key={RUNS_FILTER_ALL} id={RUNS_FILTER_ALL}>
                {page.allModels}
              </ListBoxItem>
              {modelOptions.map((option) => (
                <ListBoxItem key={option.id} id={option.id}>
                  {option.label}
                </ListBoxItem>
              ))}
            </Select>
          ) : null}
          <SearchField
            className="runs-search"
            aria-label={page.searchLabel}
            placeholder={page.searchPlaceholder}
            value={filter.query}
            onChange={(value) => patchFilter({ query: value })}
          />
          {filtersActive ? (
            <Button variant="ghost" size="sm" onPress={() => setFilter(clearRunsFilter())}>
              {page.clearFilters}
            </Button>
          ) : null}
        </div>
        <div className="runs-toolbar-actions">
          {selectable.length > 0 ? (
            <Checkbox
              aria-label={page.selectAll}
              isSelected={allSelected}
              isIndeterminate={someSelected}
              onChange={() => toggleAll()}
            />
          ) : null}
          <Button
            variant="danger"
            size="sm"
            isDisabled={!selectedActive.length || stopping}
            onPress={() => setConfirmOpen(true)}
          >
            {page.stopSelected}（{selectedActive.length}）
          </Button>
        </div>
      </div>

      {stopSummary ? (
        <p className="runs-stop-summary" role="status" data-testid="runs-stop-summary">
          {stopSummary}
        </p>
      ) : null}

      {error ? (
        <div className="runs-page-error" role="alert" data-testid="runs-sync-error">
          <strong>{text.syncError}</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {list.length === 0 ? (
        <p className="runs-page-empty">
          {error
            ? text.none
            : syncing
              ? text.runsLoading
              : filtersActive && runs.length > 0
                ? page.noMatch
                : text.runsEmpty}
        </p>
      ) : (
        <ul className="runs-list">
          {list.map((run) => {
            const title = run.title || text.untitled
            const status = phaseWord(lang, run.phase)
            const detail = phaseDetail(lang, run.phase)
            const subParts = [modelLabel(run) ?? text.none, openKind(run.kind)]
            const detailText =
              run.phase.kind === 'running' && run.phase.activity === 'subagent' ? page.waitingSubagent : detail
            if (detailText) subParts.push(detailText)
            const stoppable = isStoppableRun(run)
            return (
              <li key={run.runId} className="runs-item">
                <Checkbox
                  aria-label={page.selectRun}
                  isDisabled={!stoppable}
                  isSelected={selected.has(run.runId)}
                  onChange={() => toggle(run.runId)}
                />
                <button
                  type="button"
                  className="runs-row"
                  data-tone={runTone(run.phase)}
                  onClick={() => open(run)}
                  title={run.sessionPath ?? run.code}
                >
                  <RunDot phase={run.phase} code={run.code} unread={isUnreadRun(run)} />
                  <span className="runs-row-code">{run.code}</span>
                  <span className="runs-row-main">
                    <span className="runs-row-title">{title}</span>
                    <span className="runs-row-sub">{subParts.join(' · ')}</span>
                  </span>
                  <span className="runs-row-status">{status}</span>
                  <span className="runs-row-tools">{toolSummary(lang, run)}</span>
                  <span className="runs-row-time">{runTimeText(lang, run, now)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="runs-history-head">
        <div className="runs-history-head-l">
          <h3 className="runs-history-title">{page.historyTitle}</h3>
          <div className="runs-history-view">
            <Button
              size="sm"
              variant={historyView === 'timeline' ? 'secondary' : 'ghost'}
              onPress={() => setHistoryView('timeline')}
            >
              {page.views.timeline}
            </Button>
            <Button
              size="sm"
              variant={historyView === 'list' ? 'secondary' : 'ghost'}
              onPress={() => setHistoryView('list')}
            >
              {page.views.list}
            </Button>
          </div>
        </div>
        <div className="runs-history-day">
          <Button size="sm" variant="ghost" aria-label={page.historyPrev} onPress={() => setHistoryDay((d) => shiftDay(d, -1))}>
            ‹
          </Button>
          <span className="runs-history-date" data-testid="runs-history-date">
            {historyDay}
          </span>
          <Button size="sm" variant="ghost" aria-label={page.historyNext} onPress={() => setHistoryDay((d) => shiftDay(d, 1))}>
            ›
          </Button>
          <Button size="sm" variant="secondary" onPress={() => setHistoryDay(todayString())}>
            {page.historyToday}
          </Button>
        </div>
      </div>

      {historyError ? (
        <div className="runs-page-error" role="alert" data-testid="runs-history-error">
          <strong>{page.historyLoadError}</strong>
          <span>{historyError}</span>
        </div>
      ) : historyLoading ? (
        <p className="runs-page-empty">{page.historyLoading}</p>
      ) : historyRows.length === 0 ? (
        <p className="runs-page-empty">
          {filtersActive && (history?.records.length ?? 0) > 0 ? page.noMatch : page.historyEmpty}
        </p>
      ) : historyView === 'timeline' ? (
        <RunsTimeline records={historyRows} day={historyDay} lang={lang} onOpenRun={openLane} />
      ) : (
        <ul className="runs-list runs-history-list">
          {historyRows.map((record) => (
            <li key={record.runId} className="runs-history-row" data-terminal={record.terminal}>
              <span className="runs-row-code">{record.code}</span>
              <span className="runs-row-main">
                <span className="runs-row-title">{record.title || text.untitled}</span>
                <span className="runs-row-sub">
                  {[record.model ? record.model.label || record.model.id : text.none, openKind(record.kind)].join(' · ')}
                </span>
              </span>
              <span className="runs-row-status" data-terminal={record.terminal}>
                {page.terminal[record.terminal]}
              </span>
              <HistoryTimeline record={record} lang={lang} />
              <span className="runs-row-tools" title={page.timeline}>
                {historyToolSummary(record, lang)}
              </span>
              <span className="runs-row-time" title={page.duration}>
                {formatDuration(record.endedAt - record.startedAt, lang)}
              </span>
              <span className="runs-row-time">{formatRelative(record.endedAt, now, lang)}</span>
            </li>
          ))}
        </ul>
      )}

      {history && !historyError ? <RunsUsage records={history.records} liveRuns={runs} lang={lang} /> : null}

      <ModalOverlay className="runs-overlay" isOpen={confirmOpen} isDismissable onOpenChange={setConfirmOpen}>
        <Modal className="runs-modal">
          <Dialog title={page.stopConfirmTitle} closeLabel={page.stopCancel}>
            <p className="runs-confirm-body">{page.stopConfirmBody}</p>
            <p className="runs-confirm-list">
              {selectedActive.map((run) => `${run.code} ${run.title || text.untitled}`).join('、')}
            </p>
            <div className="runs-confirm-actions">
              <Button variant="secondary" size="sm" onPress={() => setConfirmOpen(false)}>
                {page.stopCancel}
              </Button>
              <Button variant="danger" size="sm" isPending={stopping} onPress={() => void runStop()}>
                {page.stopConfirm}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay className="runs-overlay" isOpen={recoveredOpen} isDismissable onOpenChange={setRecoveredOpen}>
        <Modal className="runs-modal">
          <Dialog title={page.recoveredTitle} closeLabel={page.recoveredClose}>
            <p className="runs-confirm-body">{page.recoveredNotice}</p>
            <div className="runs-confirm-list" data-testid="runs-recovered">
              {recoveredGroups.map((group) => (
                <div key={group.code}>
                  <span className="runs-row-code">{group.code}</span>
                  {group.texts.map((text, index) => (
                    <p key={index}>
                      <span>{text}</span>{' '}
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={() => {
                          void navigator.clipboard?.writeText(text).catch(() => undefined)
                        }}
                      >
                        {page.recoveredCopy}
                      </Button>
                    </p>
                  ))}
                </div>
              ))}
            </div>
            <div className="runs-confirm-actions">
              <Button variant="secondary" size="sm" onPress={() => setRecoveredOpen(false)}>
                {page.recoveredClose}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}
