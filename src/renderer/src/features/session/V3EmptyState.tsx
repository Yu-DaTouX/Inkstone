import { useMemo, type JSX, type ReactNode } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import type { RunSnapshot } from '../../../../shared/runs'
import { v3Text } from '../../app/v3-text'
import { UsageStrip } from '../../patterns/UsageStrip'
import { ListRow } from '../../ui'
import { BlinkCursor } from './BlinkCursor'
import { compactAgo, sessionActivityAt, sessionProjectLabel } from '../sidebar/sidebar-model'
import type { SessionSummary } from '../../../../shared/ipc'
import './v3-empty-state.css'

const RECENT_LIMIT = 4
const RECENT_TEXT: Record<'zh-CN' | 'en-US', string> = { 'zh-CN': '最近', 'en-US': 'Recent' }

function recentSessions(sessions: readonly SessionSummary[], skip: ReadonlySet<string>): SessionSummary[] {
  return sessions
    .filter((item) => !item.archivedAt && !skip.has(item.id) && !skip.has(item.path))
    .sort((a, b) => sessionActivityAt(b) - sessionActivityAt(a))
    .slice(0, RECENT_LIMIT)
}

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

export function V3EmptyState({ usage }: V3EmptyStateProps = {}): JSX.Element {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const waiting = WAITING_TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const runs = useRunsV3((s) => s.runs)
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const awaiting = useMemo(() => awaitingRuns(runs), [runs])
  const currentId = useStore((s) => s.session?.sessionId ?? null)
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const recent = useMemo(() => {
    const skip = new Set<string>(awaiting.flatMap((run) => [run.sessionId, run.sessionPath ?? ''].filter(Boolean)))
    if (currentId) skip.add(currentId)
    return recentSessions(sessions, skip)
  }, [sessions, awaiting, currentId])
  const now = Date.now()
  const langKey = lang === 'en-US' ? 'en-US' : 'zh-CN'

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
          <div className="v3-empty-greet">
            Hello world<BlinkCursor className="v3-hello-cursor" />
          </div>
          {usage === null ? null : (
            <UsageStrip
              text={{ label: text.usageStripLabel, sessions: text.usageStripSessions, days: text.usageStripDays, recent: text.usageStripRecent }}
            />
          )}
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
      {recent.length > 0 ? (
        <section className="v3-empty-recent" aria-label={RECENT_TEXT[langKey]} data-testid="v3-empty-recent">
          <h2 className="v3-empty-recent-head">{RECENT_TEXT[langKey]}</h2>
          {recent.map((item) => {
            const project = item.scope === 'global' ? '' : sessionProjectLabel(item, projects ?? [], projectNames ?? {}).label
            return (
              <ListRow
                key={item.path}
                className="v3-empty-recent-row"
                onClick={() => void useStore.getState().switchSession(item.path)}
                data-testid="v3-empty-recent-row"
                trailing={
                  <span className="v3-empty-recent-meta">
                    {project ? <span className="v3-empty-recent-project">{project}</span> : null}
                    <span className="v3-empty-recent-ago">{compactAgo(sessionActivityAt(item), now, langKey)}</span>
                  </span>
                }
              >
                {manualTitles[item.id] ?? titles[item.id] ?? (item.title || t('rail.untitled'))}
              </ListRow>
            )
          })}
        </section>
      ) : null}
    </div>
  )
}
