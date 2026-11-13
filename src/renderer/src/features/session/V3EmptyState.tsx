import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type WheelEvent } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { useUiV3 } from '../../state/ui-v3'
import type { RunSnapshot } from '../../../../shared/runs'
import type { ProjectRecord } from '../../../../shared/ipc'
import { BareButton, Button, ListRow, MiniBars, SegmentedControl, type SegmentedControlOption } from '../../ui'
import { ProjectFavicon } from '../../t3/components/ProjectFavicon'
import { compactNumber, useUsageStats } from '../usage/UsageOverview'
import { NewSessionPicker } from '../sidebar/NewSessionPicker'
import { importSessionBundles } from '../sidebar/session-import'
import { shortProject } from '../sidebar/sidebar-model'
import { asciiBackgroundEnabled } from '../ambient/ascii-field-model'
import { homeBackgroundMode, useHomeBackground } from '../ambient/home-background'
import { useTweenedNumber } from '../settings/root/use-tweened-number'
import './v3-empty-state.css'

const PROJECTS_SHOWN = 12
const RECENT_DAYS = 14
const HERE = '__cwd__'

interface HomeText {
  project: string
  allProjects: string
  usage: string
  recentTokens: string
  meta: (sessions: string, days: string) => string
  dropImport: string
}

const HOME_TEXT: Record<'zh-CN' | 'en-US', HomeText> = {
  'zh-CN': { project: '在哪个项目里开始', allProjects: '全部项目', usage: '本机用量', recentTokens: '近 14 天', meta: (sessions, days) => `${sessions} 个会话 · 活跃 ${days} 天`, dropImport: '松开即可导入会话包' },
  'en-US': { project: 'Start in', allProjects: 'All projects', usage: 'Usage on this device', recentTokens: 'last 14 days', meta: (sessions, days) => `${sessions} sessions · ${days} active days`, dropImport: 'Drop to import a session bundle' }
}

const normPath = (path: string): string => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

function worktreeHome(cwd: string | undefined): string | undefined {
  const at = cwd ? cwd.replace(/\\/g, '/').lastIndexOf('-worktrees/') : -1
  return cwd && at > 0 ? cwd.slice(0, at) : undefined
}

interface WaitingText {
  waiting: string
  question: string
  permission: string
}

const WAITING_TEXT: Record<'zh-CN' | 'en-US', WaitingText> = {
  'zh-CN': { waiting: '等待输入', question: '问了一个问题', permission: '需要授权' },
  'en-US': { waiting: 'Waiting for you', question: 'Asked a question', permission: 'Needs permission' }
}

let homeSeen = false

function awaitingRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  const latest = new Map<string, RunSnapshot>()
  for (const run of runs) {
    if (run.kind !== 'session' || run.phase.kind !== 'needs-you') continue
    const key = run.sessionId || run.runId
    const seen = latest.get(key)
    if (!seen || run.startedAt > seen.startedAt) latest.set(key, run)
  }
  return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt)
}

function ProjectRow({ text, fresh }: { text: HomeText; fresh: boolean }): JSX.Element {
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const cwd = useStore((s) => {
    const runner = s.peekedSessionId ? undefined : s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.isolationBranch) return (runner.projectId ? s.settings?.projects.find((project) => project.id === runner.projectId)?.cwd : undefined) ?? worktreeHome(runner.cwd) ?? s.settings?.cwd ?? ''
    return s.session?.cwd ?? s.settings?.cwd ?? ''
  })
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [fade, setFade] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  const { listed, current, shown } = useMemo(() => {
    const all = (projects ?? []).filter((project) => !project.archived).sort((a, b) => b.updatedAt - a.updatedAt)
    const here = cwd ? all.find((project) => normPath(project.cwd) === normPath(cwd)) ?? null : null
    const rest = all.filter((project) => project !== here)
    return { listed: all, current: here, shown: (here ? [here, ...rest] : rest).slice(0, here || !cwd ? PROJECTS_SHOWN : PROJECTS_SHOWN - 1) }
  }, [projects, cwd])

  const options = useMemo<SegmentedControlOption<string>[]>(() => {
    const items = shown.map((project) => {
      const label = project.name || projectNames?.[project.cwd] || shortProject(project.cwd)
      return { value: project.id, label, title: project.cwd, icon: <ProjectFavicon project={{ projectId: project.id, displayName: label }} />, testId: 'v3-home-project' }
    })
    return !current && cwd ? [{ value: HERE, label: shortProject(cwd), title: cwd, icon: <Folder size={14} />, testId: 'v3-home-project' }, ...items] : items
  }, [shown, current, cwd, projectNames])

  const selected = pending ?? current?.id ?? (cwd ? HERE : '')
  const hidden = listed.length - shown.length

  useEffect(() => {
    const strip = scrollRef.current?.firstElementChild
    const item = strip?.querySelector<HTMLElement>('[data-selected]')
    if (!(strip instanceof HTMLElement) || !item) return
    const left = item.offsetLeft
    const right = left + item.offsetWidth
    if (left < strip.scrollLeft) strip.scrollLeft = left
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth
  }, [selected])

  const start = async (project: ProjectRecord): Promise<void> => {
    if (busy || project === current) return
    setBusy(true)
    setPending(project.id)
    try {
      const created = await useStore.getState().newSession({ cwd: project.cwd, projectId: project.id, scope: 'project' })
      if (created.ok) await useStore.getState().refreshSessions()
      else setPending(null)
    } catch {
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const choose = (id: string): void => {
    const project = shown.find((item) => item.id === id)
    if (project) void start(project)
  }

  useEffect(() => {
    const strip = scrollRef.current?.firstElementChild
    if (!(strip instanceof HTMLElement)) return undefined
    const sync = (): void => {
      const left = strip.scrollLeft > 1
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : '')
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(strip)
    strip.addEventListener('scroll', sync, { passive: true })
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', sync)
    }
  }, [options])

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const strip = event.currentTarget.firstElementChild
    if (!(strip instanceof HTMLElement) || strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    strip.scrollLeft += event.deltaY
  }

  return (
    <div className="v3-home-row" data-landscape-floor="" data-enter={fresh ? '' : undefined} data-testid="v3-home-projects">
      <div className="v3-home-row-scroll" ref={scrollRef} onWheel={onWheel} data-fade={fade || undefined}>
        <SegmentedControl variant="plain" label={text.project} value={selected} options={options} onChange={choose} />
      </div>
      <Button
        ref={moreRef}
        variant="ghost"
        size="sm"
        icon={<FolderOpen size={14} aria-hidden />}
        isDisabled={busy}
        aria-label={text.allProjects}
        tooltip={text.allProjects}
        onPress={() => setPickerOpen(true)}
        data-testid="v3-home-pick-folder"
      >
        {hidden > 0 ? `+${hidden}` : null}
      </Button>
      <NewSessionPicker placement="top end" anchor={moreRef} open={pickerOpen} onOpenChange={setPickerOpen} onProject={(project) => void start(project)} onStarted={() => void useStore.getState().refreshSessions()} />
    </div>
  )
}

function UsageTitle({ text, bars, fresh }: { text: HomeText; bars: boolean; fresh: boolean }): JSX.Element {
  const stats = useUsageStats('all')
  const recent = stats?.heat.slice(-RECENT_DAYS) ?? []
  const values = Array.from({ length: RECENT_DAYS }, (_, i) => recent[i - (RECENT_DAYS - recent.length)]?.tokens ?? 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  const tweened = useTweenedNumber(fresh ? total : 0)
  return (
    <section className="v3-home-sky" data-landscape-sky="" data-enter={fresh ? '' : undefined} aria-label={text.usage} aria-busy={!stats || undefined} data-testid="usage-strip">
      <BareButton className="v3-home-usage" onPress={() => useUiV3.getState().navigate({ name: 'usage' })} data-testid="v3-home-usage-details">
        <span className="v3-home-usage-num" title={stats ? text.meta(stats.sessions.toLocaleString(), String(stats.activeDays)) : undefined}>
          {stats ? compactNumber(Math.round(fresh ? tweened : total)) : '—'}
        </span>
        <span className="v3-home-usage-label">
          {text.recentTokens}
          <ChevronRight size={12} aria-hidden />
        </span>
      </BareButton>
      {bars ? <MiniBars className="v3-home-usage-bars" values={values} slots={RECENT_DAYS} stretch /> : null}
    </section>
  )
}

export function V3EmptyState(): JSX.Element {
  const { lang } = useI18n()
  const t = useT()
  const home = HOME_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const waiting = WAITING_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const runs = useRunsV3((s) => s.runs)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const settings = useStore((s) => s.settings)
  const background = useHomeBackground()
  const landscape = homeBackgroundMode(background, asciiBackgroundEnabled(settings)) === 'ascii'
  const awaiting = useMemo(() => awaitingRuns(runs), [runs])
  const [fresh] = useState(() => !homeSeen)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    homeSeen = true
  }, [])

  const titleOf = (run: RunSnapshot): string => {
    const known = manualTitles[run.sessionId] ?? titles[run.sessionId] ?? sessions.find((item) => item.id === run.sessionId)?.title
    return known || run.title || t('rail.untitled')
  }

  const bundleDrag = (event: DragEvent<HTMLElement>): boolean =>
    event.dataTransfer.types.includes('Files') && [...event.dataTransfer.items].some((item) => item.kind === 'file' && (item.type === 'application/json' || item.type === ''))
  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!bundleDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
  }
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    setDropping(false)
    const paths = [...event.dataTransfer.files]
      .filter((file) => /\.json$/i.test(file.name))
      .map((file) => window.yan.pathForFile(file))
      .filter(Boolean)
    if (!paths.length) return
    event.preventDefault()
    void importSessionBundles(t, paths)
  }

  const openAwaiting = (run: RunSnapshot): void => {
    if (!run.sessionPath) return
    void useStore.getState().switchSession(run.sessionPath)
  }

  return (
    <div className="v3-empty v3-empty-page" data-testid="v3-empty" data-dropping={dropping || undefined} onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dropping ? <div className="v3-empty-drop" role="status" data-testid="v3-empty-drop">{home.dropImport}</div> : null}
      <UsageTitle text={home} bars={!landscape} fresh={fresh} />
      <div className="v3-home-gap" aria-hidden="true" />
      {awaiting.length > 0 ? (
        <section className="v3-empty-waiting" data-landscape-floor="" aria-label={waiting.waiting} data-testid="v3-empty-waiting">
          <h2 className="v3-empty-waiting-head">{waiting.waiting}</h2>
          {awaiting.map((run) => (
            <ListRow
              key={run.runId}
              className="v3-empty-waiting-row"
              onClick={() => openAwaiting(run)}
              data-testid="v3-empty-waiting-row"
              trailing={
                <span className="v3-empty-waiting-ask">
                  {run.phase.kind === 'needs-you' && run.phase.request.type === 'danger' ? waiting.permission : waiting.question}
                </span>
              }
            >
              {titleOf(run)}
            </ListRow>
          ))}
        </section>
      ) : null}
      <ProjectRow text={home} fresh={fresh} />
    </div>
  )
}
