import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { Check, Folder, FolderOpen } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import { useUiV3 } from '../../state/ui-v3'
import type { RunSnapshot } from '../../../../shared/runs'
import type { ProjectRecord } from '../../../../shared/ipc'
import { Button, Card, CardBody, CardHead, CardTitle, ListRow, MiniBars } from '../../ui'
import { ProjectFavicon } from '../../t3/components/ProjectFavicon'
import { compactNumber, useUsageStats } from '../usage/UsageOverview'
import { shortProject } from '../sidebar/sidebar-model'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import './v3-empty-state.css'

const PROJECTS_SHOWN = 6
const RECENT_DAYS = 14

interface HomeText {
  project: string
  pickFolder: string
  usage: string
  usageDetails: string
  recentTokens: string
  meta: (sessions: string, days: string) => string
}

const HOME_TEXT: Record<'zh-CN' | 'en-US', HomeText> = {
  'zh-CN': { project: '在哪个项目里开始', pickFolder: '选择文件夹…', usage: '本机用量', usageDetails: '查看详情', recentTokens: '近 14 天 Token', meta: (sessions, days) => `${sessions} 个会话 · 活跃 ${days} 天` },
  'en-US': { project: 'Start in', pickFolder: 'Choose folder…', usage: 'Usage on this device', usageDetails: 'Details', recentTokens: 'tokens, last 14 days', meta: (sessions, days) => `${sessions} sessions · ${days} active days` }
}

const normPath = (path: string): string => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

interface V3EmptyStateProps {
  usage?: ReactNode
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

function ProjectChooser({ text }: { text: HomeText }): JSX.Element {
  const t = useT()
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [busy, setBusy] = useState(false)
  const labelOf = (project: ProjectRecord): string => project.name || projectNames?.[project.cwd] || shortProject(project.cwd)
  const { current, shown } = useMemo(() => {
    const listed = (projects ?? []).filter((project) => !project.archived).sort((a, b) => b.updatedAt - a.updatedAt)
    const here = cwd ? listed.find((project) => normPath(project.cwd) === normPath(cwd)) ?? null : null
    const rest = listed.filter((project) => project !== here)
    return { current: here, shown: (here ? [here, ...rest] : rest).slice(0, here || !cwd ? PROJECTS_SHOWN : PROJECTS_SHOWN - 1) }
  }, [projects, cwd])

  const start = async (project: ProjectRecord): Promise<void> => {
    if (busy || project === current) return
    setBusy(true)
    try {
      const created = await useStore.getState().newSession({ cwd: project.cwd, projectId: project.id, scope: 'project' })
      if (created.ok) await useStore.getState().refreshSessions()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card as="section" padding="sm" className="v3-home-card" aria-label={text.project} data-testid="v3-home-projects">
      <CardHead className="v3-home-head">
        <CardTitle className="v3-home-title">{text.project}</CardTitle>
        <Button variant="ghost" size="sm" icon={<FolderOpen size={14} aria-hidden />} isDisabled={busy} onPress={() => void newSessionInPickedFolder(t)} data-testid="v3-home-pick-folder">
          {text.pickFolder}
        </Button>
      </CardHead>
      <CardBody className="v3-home-projects">
        {!current && cwd ? (
          <ListRow className="v3-home-project" current icon={<Folder size={16} aria-hidden />} description={<span title={cwd}>{cwd}</span>} trailing={<Check size={14} aria-hidden />} data-testid="v3-home-project">
            {shortProject(cwd)}
          </ListRow>
        ) : null}
        {shown.map((project) => {
          const label = labelOf(project)
          const here = project === current
          return (
            <ListRow
              key={project.id}
              className="v3-home-project"
              current={here}
              disabled={busy && !here}
              icon={<ProjectFavicon project={{ projectId: project.id, displayName: label }} className="size-5 text-[.5625rem]" />}
              description={<span title={project.cwd}>{project.cwd}</span>}
              trailing={here ? <Check size={14} aria-hidden /> : undefined}
              onClick={() => void start(project)}
              data-testid="v3-home-project"
            >
              {label}
            </ListRow>
          )
        })}
      </CardBody>
    </Card>
  )
}

function UsageSummary({ text }: { text: HomeText }): JSX.Element {
  const stats = useUsageStats('all')
  const recent = stats?.heat.slice(-RECENT_DAYS) ?? []
  const values = Array.from({ length: RECENT_DAYS }, (_, i) => recent[i - (RECENT_DAYS - recent.length)]?.tokens ?? 0)
  const recentTotal = values.reduce((sum, value) => sum + value, 0)
  const dash = '—'
  return (
    <Card as="section" padding="sm" className="v3-home-card" aria-label={text.usage} aria-busy={!stats || undefined} data-testid="usage-strip">
      <CardHead className="v3-home-head">
        <CardTitle className="v3-home-title">{text.usage}</CardTitle>
        <Button variant="ghost" size="sm" onPress={() => useUiV3.getState().navigate({ name: 'usage' })} data-testid="v3-home-usage-details">
          {text.usageDetails}
        </Button>
      </CardHead>
      <CardBody className="v3-home-usage" title={stats ? text.meta(stats.sessions.toLocaleString(), String(stats.activeDays)) : undefined}>
        <span className="v3-home-usage-num">{stats ? compactNumber(recentTotal) : dash}</span>
        <span className="v3-home-usage-label">{text.recentTokens}</span>
        <MiniBars className="v3-home-usage-bars" values={values} slots={RECENT_DAYS} stretch />
      </CardBody>
    </Card>
  )
}

export function V3EmptyState({ usage }: V3EmptyStateProps = {}): JSX.Element {
  const { lang } = useI18n()
  const t = useT()
  const home = HOME_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const waiting = WAITING_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const runs = useRunsV3((s) => s.runs)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const awaiting = useMemo(() => awaitingRuns(runs), [runs])

  const titleOf = (run: RunSnapshot): string => {
    const known = manualTitles[run.sessionId] ?? titles[run.sessionId] ?? sessions.find((item) => item.id === run.sessionId)?.title
    return known || run.title || t('rail.untitled')
  }

  const openAwaiting = (run: RunSnapshot): void => {
    if (!run.sessionPath) return
    void useStore.getState().switchSession(run.sessionPath)
  }

  return (
    <div className="v3-empty v3-empty-page" data-testid="v3-empty">
      <div className="v3-empty-cols">
        <div className="v3-empty-main">
          <ProjectChooser text={home} />
          {usage === null ? null : <UsageSummary text={home} />}
          {awaiting.length > 0 ? (
            <section className="v3-empty-waiting" aria-label={waiting.waiting} data-testid="v3-empty-waiting">
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
        </div>
        {usage ?? null}
      </div>
    </div>
  )
}
