import { useEffect, useMemo } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PlaybookPanel } from './PlaybookPanel'
import { FollowPanel } from './FollowPanel'
import { goalDisplayTitle } from '../../state/goal-view'
import type { Space } from '../../../../shared/space'
import type { SpaceView } from '../../state/space-view'

/**
 * 空间概览（实施-25 P04 / T04-3）。
 *
 * 回答一个问题：「回到这个空间，现在该干什么」。
 * 所以顺序是 目标 → 继续 → 资料 → 成果 → 需要我，每块各自有
 * 空态（没有目标和「加载失败」必须看起来不一样）。
 *
 * 数据全部来自现有 store；资料用 P03 的 `library`（唯一事实源），
 * 这里**不做第二次过滤或解析** —— 列表已经在主进程按引用态判定过了。
 */
interface Props {
  space?: Space
  spaceId?: string
  onView: (view: SpaceView) => void
  onOpenSession: (path: string) => void
}

export function SpaceOverview({ space, spaceId, onView, onOpenSession }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const goal = useStore((s) => s.goal)
  const goalLoading = useStore((s) => s.goalLoading)
  const goalError = useStore((s) => s.goalError)
  const todos = useStore((s) => s.todos)
  const library = useStore((s) => s.library)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const refreshPlaybooks = useStore((s) => s.refreshPlaybooks)

  /* 模板按空间过滤（不挑空间的模板任何空间都看得到） */
  useEffect(() => {
    void refreshPlaybooks(spaceId ?? null)
  }, [spaceId, refreshPlaybooks])

  /* 空间内的会话：这一块是「继续」的真正入口（地图与首页都不是按空间分的） */
  const inSpace = useMemo(
    () =>
      spaceId
        ? sessions
            .filter((s) => s.spaceId === spaceId)
            .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
            .slice(0, 5)
        : [],
    [sessions, spaceId]
  )

  const sources = useMemo(
    () =>
      spaceId
        ? library.filter((s) => s.spaceId === spaceId).slice(0, 4)
        : library.slice(0, 4),
    [library, spaceId]
  )

  const goalSteps = goal?.steps ?? []
  const goalDone = goalSteps.filter((x) => x.status === 'done').length
  const pendingSteps = goalSteps.filter((x) => x.status !== 'done').slice(0, 3)
  const openTodos = todos.filter((x) => !x.done).slice(0, 3)

  const time = (ms?: number): string => {
    if (!ms) return ''
    try {
      return new Date(ms).toLocaleDateString()
    } catch {
      return ''
    }
  }

  return (
    <div className="wb-ov" data-testid="space-overview">
      {space?.description ? <p className="wb-ov-desc">{space.description}</p> : null}

      <div className="wb-ov-grid">
        {/* ---- 目标 ---- */}
        <section className="wb-card" data-testid="space-ov-goal">
          <h2 className="wb-card-title">
            <Icon name="shield-check" size={12} />
            {t('space.ov.goal')}
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

        {/* ---- 需要我 ---- */}
        <section className="wb-card" data-testid="space-ov-need">
          <h2 className="wb-card-title">
            <Icon name="alert-circle" size={12} />
            {t('space.ov.needMe')}
          </h2>
          {pendingSteps.length === 0 && openTodos.length === 0 ? (
            <p className="wb-card-empty">{t('space.ov.needMeNone')}</p>
          ) : (
            <ul className="wb-list">
              {pendingSteps.map((s) => (
                <li key={`s-${s.title}`} className="wb-source-item">
                  <Icon name="shield-check" size={12} />
                  <span className="wb-list-title">{s.title}</span>
                </li>
              ))}
              {openTodos.map((x) => (
                <li key={`t-${x.text}`} className="wb-source-item">
                  <Icon name="checklist" size={12} />
                  <span className="wb-list-title">{x.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- 继续 ---- */}
        <section className="wb-card" data-testid="space-ov-continue">
          <h2 className="wb-card-title">
            <Icon name="history" size={12} />
            {t('space.ov.continue')}
          </h2>
          {!spaceId ? (
            <p className="wb-card-empty">{t('space.ov.noSpace')}</p>
          ) : inSpace.length === 0 ? (
            <p className="wb-card-empty">{t('space.ov.continueNone')}</p>
          ) : (
            <ul className="wb-list">
              {inSpace.map((s) => (
                <li key={s.path}>
                  <button className="wb-list-item" onClick={() => onOpenSession(s.path)}>
                    <span className="wb-list-title">{s.title}</span>
                    <span className="wb-list-meta">
                      {(s.cwd && projectNames?.[s.cwd]) || s.cwd.split(/[\/]/).filter(Boolean).pop()} ·{' '}
                      {time(s.lastActivityAt ?? s.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- 最新资料 ---- */}
        <section className="wb-card" data-testid="space-ov-sources">
          <h2 className="wb-card-title">
            <Icon name="folder-open" size={12} />
            {t('space.ov.sources')}
          </h2>
          {sources.length === 0 ? (
            <p className="wb-card-empty">{t('space.ov.sourcesNone')}</p>
          ) : (
            <>
              <ul className="wb-list">
                {sources.map((s) => (
                  <li key={s.id} className="wb-source-item">
                    <Icon name={s.kind === 'image' ? 'layers' : s.kind === 'file' ? 'folder' : 'globe'} size={12} />
                    <span className="wb-list-title">{s.title}</span>
                  </li>
                ))}
              </ul>
              <button className="wb-open-map" data-testid="space-ov-sources-all" onClick={() => onView('library')}>
                {t('space.ov.sourcesAll')}
                <Icon name="chevron-right" size={12} />
              </button>
            </>
          )}
        </section>

        {/* ---- 最近成果（实现归 P06） ---- */}
        <section className="wb-card" data-testid="space-ov-artifacts">
          <h2 className="wb-card-title">
            <Icon name="tag" size={12} />
            {t('space.ov.artifacts')}
          </h2>
          <p className="wb-card-empty">{t('space.pendingArtifact')}</p>
        </section>

        {/*
         * 办事模板（实施-25 P14）。
         * 放在概览里而不是单开一个页：模板是「回到这个空间可以再干一次的事」，
         * 与「继续 / 资料」同一层。点开模板不会立刻做任何事 —— 先把范围摊开（T14-3）。
         */}
        <section className="wb-card" data-testid="space-ov-playbook-card">
          <h2 className="wb-card-title">
            <Icon name="layers" size={12} />
            {t('space.ov.playbooks')}
          </h2>
          <PlaybookPanel />
        </section>

        {/*
         * 持续关注（实施-25 P16）。
         * 顶上那句「只在砚开着的时候看」是这张卡的固定组成部分，不是可选提示 ——
         * 不把它写出来，用户会默认「关注 = 后台一直盯着」。
         */}
        <section className="wb-card" data-testid="space-ov-follow-card">
          <h2 className="wb-card-title">
            <Icon name="history" size={12} />
            {t('space.ov.follow')}
          </h2>
          <FollowPanel spaceId={spaceId} />
        </section>
      </div>
    </div>
  )
}
