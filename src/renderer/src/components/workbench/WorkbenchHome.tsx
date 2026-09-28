import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { samePath } from '../../../../shared/session-path'
import { useSessionSources } from '../../state/daily-sources'
import { goalDisplayTitle } from '../../state/goal-view'
import { buildSessionMap } from '../../../../shared/session-map'

/**
 * 工作台首页（实施-18 S3；实施-27 B3 收敛为「一主行动 + ≤3 张有内容的卡」）。
 *
 * 改动前的首页是 7 张卡平铺，其中 4 张在多数新会话里是空的 ——
 * 「空卡片」不但占位置，还让人以为「这里本来就有这些功能，只是没数据」。
 * 现在的规则：
 *   · 顶部只回答一个问题 ——「接着上次继续」；没有可继续的会话才退化成一句提示；
 *   · 下面最多三张卡，**每张都必须有内容**（空的不渲染，不是画成空态）；
 *   · 数据仍然只消费现有 store 与 `sources.list` / `verifyFiles`，不新增 IPC。
 */

interface Props {
  onOpenSession: (path: string) => void
  onOpenMap: () => void
  /** 打开空间概览（实施-25 P04 / T04-2）。首页不重复概览的内容，只给入口。 */
  onOpenSpace: () => void
  /** 打开任务收件箱（实施-28 T5）：跨会话的待处理入口 */
  onOpenInbox: () => void
}

/* 稳定的空对象：selector 每次返回新引用会让 zustand 无限重渲染 */
const NO_PROJECT_NAMES: Record<string, string> = {}

export function WorkbenchHome({ onOpenSession, onOpenMap, onOpenSpace, onOpenInbox }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  /*
   * 收件箱计数（实施-28 T5）。
   *
   * 只算真需要人的三档（待确认 / 等你回答 / 出错），与左栏角标同一口径 ——
   * 两处显示不同的数字比不显示更让人困惑。
   */
  const [inboxWaiting, setInboxWaiting] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await window.yan.taskInbox.page({ limit: 1, offset: 0 })
        if (!alive) return
        setInboxWaiting((res.counts.needs_review ?? 0) + (res.counts.waiting_user ?? 0) + (res.counts.failed ?? 0))
      } catch {
        /* 读不到就不出卡（不用 0 冒充“没有事”） */
      }
    })()
    return () => {
      alive = false
    }
  }, [sessions.length])
  const session = useStore((s) => s.session)
  const goal = useStore((s) => s.goal)
  const goalLoading = useStore((s) => s.goalLoading)
  const goalError = useStore((s) => s.goalError)
  const todos = useStore((s) => s.todos)
  const spaces = useStore((s) => s.spaces)
  const library = useStore((s) => s.library)
  const projectNames = useStore((s) => s.settings?.projectNames ?? NO_PROJECT_NAMES)
  /* 今天可复习（P12）：只读到期数量，点进去才挑题 —— 首页不做「开始学习」。 */
  const reviewDue = useStore((s) => s.reviewDue)
  const refreshReviewDue = useStore((s) => s.refreshReviewDue)
  const openSpaceView = useStore((s) => s.openSpaceView)
  useEffect(() => {
    void refreshReviewDue()
  }, [refreshReviewDue])

  const sources = useSessionSources(session?.sessionId)

  /** 可继续的会话：按最近活动排序，**排除当前这条**（它就在屏幕上） */
  const recent = useMemo(
    () =>
      [...sessions]
        .filter((s) => s.path !== session?.sessionFile)
        .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt)),
    [sessions, session?.sessionFile]
  )
  const heroTarget = recent[0]

  const mapSummary = useMemo(() => buildSessionMap({ sessions }).stats, [sessions])

  /*
   * 当前空间：**从当前会话的归属派生**，不另存一份（T04-8）。
   * 首页与概览用的是同一个来源，所以不会出现「首页说 A、概览说 B」。
   */
  const spaceId = useMemo(
    () =>
      sessions.find((s) => s.id === session?.sessionId || samePath(s.path, session?.sessionFile))?.spaceId,
    [sessions, session?.sessionFile]
  )
  const space = useMemo(() => spaces.find((s) => s.id === spaceId), [spaces, spaceId])
  const spaceSessionCount = useMemo(
    () => (spaceId ? sessions.filter((s) => s.spaceId === spaceId).length : 0),
    [sessions, spaceId]
  )
  const spaceSourceCount = useMemo(
    () => (spaceId ? library.filter((s) => s.spaceId === spaceId).length : 0),
    [library, spaceId]
  )

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

  /*
   * 卡片候选 —— 只放**真有内容**的，最多三张。
   * 顺序即优先级：正在做的事 > 今天可复习 > 空间 > 资料 > 会话地图。
   */
  const cards: { id: string; node: React.ReactNode }[] = []

  /*
   * 待我处理（实施-28 T5）。放在**最前**：它是首页唯一一个「别人在等我」的信号，
   * 比其他几项（我在做的事 / 可以复习）都更该先看一眼。
   * 没有要处理的就不出卡 —— 与 B3 的「空卡不画」规则一致。
   */
  if (inboxWaiting > 0) {
    cards.push({
      id: 'inbox',
      node: (
        <section className="wb-card" data-testid="wb-card-inbox" key="inbox">
          <h2 className="wb-card-title">
            <Icon name="checklist" size={12} />
            {t('wb.inboxCard')}
          </h2>
          <p className="wb-card-main">{t('wb.inboxCount', { n: inboxWaiting })}</p>
          <button className="btn sm wb-card-action" onClick={onOpenInbox} data-testid="wb-inbox-open">
            {t('inbox.open')}
          </button>
        </section>
      )
    })
  }

  if (goal?.goalId || todos.length > 0 || goalLoading) {
    cards.push({
      id: 'focus',
      node: (
        <section className="wb-card" data-testid="wb-card-focus" key="focus">
          <h2 className="wb-card-title">
            <Icon name="shield-check" size={12} />
            {t('wb.focusCard')}
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
          ) : null}
          {todos.length > 0 ? (
            <>
              <p className="wb-card-meta">{t('wb.todosProgress', { done: doneCount, total: todos.length })}</p>
              {currentTodo ? <p className="wb-card-main">{currentTodo.text}</p> : null}
            </>
          ) : null}
        </section>
      )
    })
  }

  if (reviewDue && reviewDue.items.length > 0) {
    cards.push({
      id: 'review',
      node: (
        <section className="wb-card" data-testid="wb-card-review" key="review">
          <h2 className="wb-card-title">
            <Icon name="history" size={12} />
            {t('wb.reviewCard')}
          </h2>
          <p className="wb-card-main" data-testid="wb-card-review-count">
            {t('wb.reviewCount', { n: reviewDue.items.length })}
          </p>
          <p className="wb-card-meta" data-testid="wb-card-review-meta">
            {t('wb.reviewMeta', { total: reviewDue.total })}
          </p>
          <button className="btn sm wb-open-map" data-testid="wb-open-review" onClick={() => openSpaceView('learning')}>
            {t('wb.reviewOpen')}
            <Icon name="chevron-right" size={12} />
          </button>
        </section>
      )
    })
  }

  if (space) {
    cards.push({
      id: 'space',
      node: (
        <section className="wb-card" data-testid="wb-card-space" key="space">
          <h2 className="wb-card-title">
            <Icon name="layers" size={12} />
            {t('wb.spaceCard')}
          </h2>
          <p className="wb-card-main">{space.name}</p>
          <p className="wb-card-meta" data-testid="wb-card-space-count">
            {t('wb.spaceCardCount', { sessions: spaceSessionCount, sources: spaceSourceCount })}
          </p>
          <button className="btn sm wb-open-map" data-testid="wb-open-space" onClick={onOpenSpace}>
            {t('wb.spaceCardOpen')}
            <Icon name="chevron-right" size={12} />
          </button>
        </section>
      )
    })
  }

  if (!sources.loading && !sources.error && sources.all.length > 0) {
    cards.push({
      id: 'sources',
      node: (
        <section className="wb-card" data-testid="wb-card-sources" key="sources">
          <h2 className="wb-card-title">
            <Icon name="library" size={12} />
            {t('wb.sources')}
          </h2>
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
                <Icon name={s.kind === 'image' ? 'image' : s.kind === 'file' ? 'folder' : 'globe'} size={12} />
                <span className="wb-list-title">{s.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )
    })
  }

  /*
   * 会话地图只在**有东西可看**时给入口（>1 条会话才值得摊开看）。
   * 它原来是常驻卡片，但单会话时那张卡只有一个数字 —— 纯噪音。
   */
  if (mapSummary.total > 1) {
    cards.push({
      id: 'map',
      node: (
        <section className="wb-card wb-card-map" data-testid="wb-card-map" key="map">
          <h2 className="wb-card-title">
            <Icon name="map" size={12} />
            {t('map.title')}
          </h2>
          <p className="wb-card-meta">{t('map.stats', { lanes: mapSummary.laneCount, nodes: mapSummary.total })}</p>
          <button className="btn sm wb-open-map" onClick={onOpenMap} data-testid="wb-open-map">
            {t('wb.open')}
            <Icon name="chevron-right" size={12} />
          </button>
        </section>
      )
    })
  }

  return (
    <div className="wb-home" data-testid="workbench-home">
      <header className="wb-home-head">
        <Icon name="sparkles" size={14} />
        <span>{t('wb.home')}</span>
      </header>

      {/* 一主行动：接着上次继续；没有可继续的就只说一句，让输入框当主角 */}
      {heroTarget ? (
        <section className="wb-hero" data-testid="wb-hero">
          <div className="wb-hero-text">
            <p className="wb-hero-label">{t('wb.heroContinue')}</p>
            <p className="wb-hero-title" data-testid="wb-hero-title">
              {heroTarget.title}
            </p>
            <p className="wb-hero-meta">
              {shortName(heroTarget.cwd)} · {time(heroTarget.lastActivityAt ?? heroTarget.createdAt)}
            </p>
          </div>
          <button className="btn primary wb-hero-go" data-testid="wb-hero-go" onClick={() => onOpenSession(heroTarget.path)}>
            {t('wb.open')}
            <Icon name="chevron-right" size={12} />
          </button>
        </section>
      ) : (
        <section className="wb-hero wb-hero-plain" data-testid="wb-hero">
          <p className="wb-hero-label">{t('wb.heroStart')}</p>
        </section>
      )}

      {cards.length > 0 ? (
        <div className="wb-home-grid">{cards.slice(0, 3).map((c) => c.node)}</div>
      ) : null}
    </div>
  )
}
