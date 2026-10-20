import { useMemo, type JSX, type ReactNode } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useRunsV3 } from '../../state/runs-v3'
import type { RunSnapshot } from '../../../../shared/runs'
import { v3Text } from '../../app/v3-text'
import { UsagePattern } from '../../patterns/UsagePattern'
import { UsageStrip } from '../../patterns/UsageStrip'
import './v3-empty-state.css'

export interface V3EmptyStateProps {
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
            <span className="v3-empty-prompt" aria-hidden>&gt;</span>
            <span>HELLO WORLD<span className="v3-hello-cursor" aria-hidden>_</span></span>
          </div>
          {awaiting.length > 0 ? (
            <section className="v3-empty-waiting" aria-label={waiting.waiting} data-testid="v3-empty-waiting">
              <h2 className="v3-empty-waiting-head">{waiting.waiting}</h2>
              {awaiting.map((run) => (
                <button
                  key={run.runId}
                  type="button"
                  className="ui-row v3-empty-waiting-row"
                  onClick={() => openAwaiting(run)}
                  data-testid="v3-empty-waiting-row"
                >
                  <span className="v3-empty-waiting-title">{titleOf(run)}</span>
                  <span className="v3-empty-waiting-ask">
                    {run.phase.kind === 'needs-you' && run.phase.request.type === 'danger' ? waiting.permission : waiting.question}
                  </span>
                </button>
              ))}
            </section>
          ) : null}
          {usage === null ? null : (
            <UsageStrip
              text={{ label: text.usageStripLabel, sessions: text.usageStripSessions, days: text.usageStripDays, recent: text.usageStripRecent }}
            />
          )}
        </div>
        {usage === undefined ? <UsagePattern emptyNote={text.usageEmptyNote} /> : usage}
      </div>
    </div>
  )
}
