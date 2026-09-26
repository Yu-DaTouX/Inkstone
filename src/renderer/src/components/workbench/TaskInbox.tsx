import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { TASK_STATUS_ORDER, type TaskCard, type TaskInboxPage, type TaskStatus } from '../../../../shared/task-inbox'

/**
 * 任务收件箱（实施-28 T2）。
 *
 * ── 它回答什么 ──
 *   不是「有哪些会话」，而是「**现在要我看什么**」。所以：
 *     · 排序由 main 侧给（要人处理的在前），界面不重排；
 *     · 进度不用百分比（没有依据就不给，`progress` 是字符串）；
 *     · `needs_review` 是近似判定，卡片上明确标出来 —— 不假装精确。
 *
 * ── 为什么没有「批量操作」 ──
 *   收件箱里的每一条都对应一个真实会话，批量「全部完成」会让人误以为
 *   关掉了窗口就等于处理完了。这里只提供「打开」与「不管了」两个动作，
 *   且「不管了」只是本地可见性（写 `YAN_DIR/task-inbox.json`），不动会话。
 */

const PAGE_SIZE = 30

interface Props {
  /** 打开某个会话（收件箱自己不切会话，把 path 交给 App） */
  onOpenSession: (path: string) => void
}

/* 状态在列表里的先后（与 main 侧投影同源，避免两处各写一套顺序） */
const STATUS_ORDER: TaskStatus[] = (Object.keys(TASK_STATUS_ORDER) as TaskStatus[]).sort(
  (a, b) => TASK_STATUS_ORDER[a] - TASK_STATUS_ORDER[b]
)

/**
 * 状态 → 文案键。
 *
 * 写成显式映射而不是拼字符串：拼出来的 key 要向上转型才过类型检查，
 * 那等于把“键名写错”这件事从编译期推到运行期（界面会直接显示键名）。
 */
const STATUS_LABEL: Record<TaskStatus, MessageKey> = {
  needs_review: 'inbox.status.needs_review',
  waiting_user: 'inbox.status.waiting_user',
  failed: 'inbox.status.failed',
  running: 'inbox.status.running',
  pending: 'inbox.status.pending',
  done: 'inbox.status.done',
  dismissed: 'inbox.status.dismissed'
}

export function TaskInbox({ onOpenSession }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const [page, setPage] = useState<TaskInboxPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all')
  const [limit, setLimit] = useState(PAGE_SIZE)

  const load = useCallback(
    async (nextLimit: number, status: TaskStatus | 'all') => {
      setLoading(true)
      setError(null)
      try {
        const res = await window.yan.taskInbox.page({
          limit: nextLimit,
          offset: 0,
          ...(status === 'all' ? {} : { status: [status] })
        })
        setPage(res)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    void load(limit, filter)
  }, [load, limit, filter])

  /* 会话 id → 会话文件路径（打开时要用 path；找不到就禁用那个按钮） */
  const pathOf = (sessionId: string): string | undefined => sessions.find((s) => s.id === sessionId)?.path

  const dismiss = async (card: TaskCard): Promise<void> => {
    await window.yan.taskInbox.dismiss(card.sessionId)
    await load(limit, filter)
  }

  /**
   * 打开会话：先记一笔「我看过了」，再切过去。
   *
   * 顺序不能反：切完会话后界面可能已经被卸载，那条 IPC 就发不出去了，
   * 而 `needs_review` 会一直把这个会话报成待确认。
   */
  const open = async (card: TaskCard, path: string): Promise<void> => {
    try {
      await window.yan.taskInbox.seen(card.sessionId)
    } catch {
      /* 记不上最多多重提醒一次，不阻塞打开 */
    }
    onOpenSession(path)
  }

  const cards = page?.cards ?? []
  const counts = page?.counts

  return (
    <div className="wb-inbox" data-testid="task-inbox">
      <header className="wb-inbox-head">
        <div className="wb-inbox-title">
          <Icon name="checklist" size={14} />
          <span>{t('inbox.title')}</span>
          {page ? <b className="wb-inbox-total">{page.total}</b> : null}
        </div>
        <button
          className="wb-inbox-refresh"
          onClick={() => void load(limit, filter)}
          disabled={loading}
          data-testid="inbox-refresh"
          title={t('inbox.refresh')}
        >
          <Icon name="refresh" size={12} />
          <span>{t('inbox.refresh')}</span>
        </button>
      </header>

      <p className="wb-inbox-note">{t('inbox.subtitle')}</p>

      {/* 状态筛选：只显示**真的有**的档（计数为 0 的档画出来只是噪音） */}
      <div className="wb-inbox-filters" role="group" aria-label={t('inbox.filter.all')}>
        <button
          className={filter === 'all' ? 'on' : ''}
          onClick={() => {
            setFilter('all')
            setLimit(PAGE_SIZE)
          }}
          data-testid="inbox-filter-all"
        >
          {t('inbox.filter.all')}
          {page ? <b>{Object.values(counts ?? {}).reduce((a, b) => a + b, 0)}</b> : null}
        </button>
        {STATUS_ORDER.filter((s) => (counts?.[s] ?? 0) > 0).map((s) => (
          <button
            key={s}
            className={filter === s ? 'on' : ''}
            onClick={() => {
              setFilter(s)
              setLimit(PAGE_SIZE)
            }}
            data-testid={`inbox-filter-${s}`}
          >
            {t(STATUS_LABEL[s])}
            <b>{counts?.[s] ?? 0}</b>
          </button>
        ))}
      </div>

      {error ? (
        <div className="wb-inbox-error" data-testid="inbox-error">
          {t('inbox.failed')}: {error}
        </div>
      ) : null}

      {page && page.degraded > 0 ? (
        <div className="wb-inbox-degraded" data-testid="inbox-degraded">
          {t('inbox.degraded').replace('{n}', String(page.degraded))}
        </div>
      ) : null}

      {loading && !page ? <div className="wb-inbox-loading">{t('inbox.loading')}</div> : null}

      {page && cards.length === 0 ? (
        <div className="wb-inbox-empty" data-testid="inbox-empty">
          <Icon name="check-circle" size={16} />
          <span>{t('inbox.empty')}</span>
        </div>
      ) : null}

      <ul className="wb-inbox-list">
        {cards.map((c) => {
          const path = pathOf(c.sessionId)
          return (
            <li key={c.id} className="wb-inbox-card" data-testid="inbox-card" data-status={c.status}>
              <div className="wb-inbox-card-main">
                <span className={`wb-inbox-badge s-${c.status}`}>
                  {t(STATUS_LABEL[c.status])}
                  {c.approximate ? <i title={t('inbox.approximate')}>~</i> : null}
                </span>
                <span className="wb-inbox-card-title">{c.title}</span>
                {c.progress ? <span className="wb-inbox-progress">{c.progress}</span> : null}
              </div>
              {c.reason ? <div className="wb-inbox-reason">{c.reason}</div> : null}
              <div className="wb-inbox-card-foot">
                <span className="wb-inbox-when">{new Date(c.updatedAt).toLocaleString()}</span>
                <div className="wb-inbox-actions">
                  <button
                    onClick={() => void open(c, path as string)}
                    disabled={!path}
                    data-testid="inbox-open"
                  >
                    {t('inbox.open')}
                  </button>
                  <button onClick={() => void dismiss(c)} data-testid="inbox-dismiss">
                    {t('inbox.dismiss')}
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {page && page.total > cards.length ? (
        <button
          className="wb-inbox-more"
          onClick={() => setLimit((n) => n + PAGE_SIZE)}
          disabled={loading}
          data-testid="inbox-more"
        >
          {t('inbox.loadMore')}
        </button>
      ) : null}
    </div>
  )
}
