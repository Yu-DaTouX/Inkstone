import { useMemo } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useSessionSources } from '../../state/daily-sources'
import { goalDisplayTitle } from '../../state/goal-view'
import { buildSessionMap } from '../../../../shared/session-map'

/**
 * 工作台首页（实施-18 S3）—— 日常模式下、当前会话还没有消息时的中栏内容。
 *
 * 四张只读卡片 + 一个地图入口，每张卡各自有 loading / empty / error：
 * 把失败画成空会让用户以为「本来就没有」，那是两个完全不同的结论。
 *
 * 数据只消费现有 store 与 `sources.list` / `verifyFiles`，不新增 IPC，
 * 也不落任何业务数据。
 */

interface Props {
  onOpenSession: (path: string) => void
  onOpenMap: () => void
}

/* 稳定的空对象：selector 每次返回新引用会让 zustand 无限重渲染 */
const NO_PROJECT_NAMES: Record<string, string> = {}

export function WorkbenchHome({ onOpenSession, onOpenMap }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const goal = useStore((s) => s.goal)
  const goalLoading = useStore((s) => s.goalLoading)
  const goalError = useStore((s) => s.goalError)
  const todos = useStore((s) => s.todos)
  const projectNames = useStore((s) => s.settings?.projectNames ?? NO_PROJECT_NAMES)

  const sources = useSessionSources(session?.sessionId)

  /* 继续：按真实最近活动取前 6 条 */
  const recent = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
        .slice(0, 6),
    [sessions]
  )

  const mapSummary = useMemo(() => buildSessionMap({ sessions }).stats, [sessions])

  const doneCount = todos.filter((x) => x.done).length
  const currentTodo = todos.find((x) => !x.done)
  const goalSteps = goal?.steps ?? []
  const goalDone = goalSteps.filter((x) => x.status === 'done').length

  const time = (ms?: number): string => {
    if (!ms) return ''
    try {
      return new Date(ms).toLocaleDateString()
    } catch {
      return ''
    }
  }

  const shortName = (cwd: string): string =>
    projectNames[cwd] || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd

  return (
    <div className="wb-home" data-testid="workbench-home">
      <header className="wb-home-head">
        <Icon name="sparkles" size={14} />
        <span>{t('wb.home')}</span>
      </header>

      <div className="wb-home-grid">
        {/* ---- 继续 ---- */}
        <section className="wb-card" data-testid="wb-card-continue">
          <h2 className="wb-card-title">
            <Icon name="history" size={12} />
            {t('wb.continue')}
          </h2>
          {recent.length === 0 ? (
            <p className="wb-card-empty">{t('wb.recentNone')}</p>
          ) : (
            <ul className="wb-list">
              {recent.map((s) => (
                <li key={s.path}>
                  <button className={`wb-list-item ${s.path === session?.sessionFile ? 'on' : ''}`} onClick={() => onOpenSession(s.path)}>
                    <span className="wb-list-title">{s.title}</span>
                    <span className="wb-list-meta">
                      {shortName(s.cwd)} · {time(s.lastActivityAt ?? s.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- 目标 ---- */}
        <section className="wb-card" data-testid="wb-card-goal">
          <h2 className="wb-card-title">
            <Icon name="shield-check" size={12} />
            {t('wb.goal')}
          </h2>
          {goalLoading ? (
            <p className="wb-card-empty">{t('wb.goalLoading')}</p>
          ) : goalError ? (
            <p className="wb-card-empty error">{t('wb.goalError')}</p>
          ) : goal?.goalId ? (
            <>
              <p className="wb-card-main">{goalDisplayTitle(goal)}</p>
              {goalSteps.length > 0 ? (
                <p className="wb-card-meta">{t('wb.goalSteps', { done: goalDone, total: goalSteps.length })}</p>
              ) : null}
            </>
          ) : (
            <p className="wb-card-empty">{t('wb.goalNone')}</p>
          )}
        </section>

        {/* ---- 任务 ---- */}
        <section className="wb-card" data-testid="wb-card-todos">
          <h2 className="wb-card-title">
            <Icon name="checklist" size={12} />
            {t('wb.todos')}
          </h2>
          {todos.length === 0 ? (
            <p className="wb-card-empty">{t('wb.todosNone')}</p>
          ) : (
            <>
              <p className="wb-card-meta">{t('wb.todosProgress', { done: doneCount, total: todos.length })}</p>
              {currentTodo ? <p className="wb-card-main">{currentTodo.text}</p> : null}
            </>
          )}
        </section>

        {/* ---- 来源 ---- */}
        <section className="wb-card" data-testid="wb-card-sources">
          <h2 className="wb-card-title">
            <Icon name="folder-open" size={12} />
            {t('wb.sources')}
          </h2>
          {sources.loading ? (
            <p className="wb-card-empty">{t('wb.sourcesLoading')}</p>
          ) : sources.error ? (
            <p className="wb-card-empty error">{t('wb.sourcesError')}</p>
          ) : sources.all.length === 0 ? (
            <p className="wb-card-empty">{t('src.empty')}</p>
          ) : (
            <>
              <p className="wb-card-meta">
                {t('wb.sourcesCounts', {
                  images: sources.images.length,
                  files: sources.files.length,
                  webs: sources.webs.length
                })}
              </p>
              <ul className="wb-list">
                {sources.all.slice(0, 3).map((s) => (
                  <li key={s.sourceId} className="wb-source-item">
                    <Icon name={s.kind === 'image' ? 'layers' : s.kind === 'file' ? 'folder' : 'globe'} size={12} />
                    <span className="wb-list-title">{s.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* ---- 会话地图入口 ---- */}
        <section className="wb-card wb-card-map" data-testid="wb-card-map">
          <h2 className="wb-card-title">
            <Icon name="layers" size={12} />
            {t('map.title')}
          </h2>
          <p className="wb-card-meta">{t('map.stats', { lanes: mapSummary.laneCount, nodes: mapSummary.total })}</p>
          <button className="wb-open-map" onClick={onOpenMap} data-testid="wb-open-map">
            {t('wb.open')}
            <Icon name="chevron-right" size={12} />
          </button>
        </section>
      </div>
    </div>
  )
}
