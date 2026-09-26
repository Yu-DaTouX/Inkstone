import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { FOLLOW_KIND_LABELS, FOLLOW_APP_ONLY_NOTE, formatWhen, type FollowKind } from '../../../../shared/follow'

/** 常用节奏（分钟）。自定义走输入框 —— 但不允许短于 30 分钟。 */
const PRESET_MINUTES = [1440, 4320, 10080]

/**
 * 持续关注（实施-25 P16）。
 *
 * 界面上最要紧的一句话在顶上：**关注只在砚开着的时候看**。
 * 所以卡片从不写「已跟进」—— 只有「上次看：X」与「下次 Y」两种状态，
 * 以及一句「应用没开的那段时间不会被跟进」。
 *
 * 第二个要点：点「现在看一下」**只填不发** —— 与 P14 的办事模板同一套做法，
 * 要不要真的去看由用户按发送决定（不自动代学那条也靠它落实）。
 */
export function FollowPanel({ spaceId }: { spaceId?: string }): React.JSX.Element {
  const t = useT()
  const views = useStore((s) => s.followViews)
  const due = useStore((s) => s.followDue)
  const refreshFollows = useStore((s) => s.refreshFollows)
  const saveWatch = useStore((s) => s.saveWatch)
  const updateWatch = useStore((s) => s.updateWatch)
  const removeWatch = useStore((s) => s.removeWatch)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)

  const [draftOpen, setDraftOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<FollowKind>('custom')
  const [minutes, setMinutes] = useState(1440)
  const [place, setPlace] = useState('')

  useEffect(() => {
    void refreshFollows(spaceId ?? null)
  }, [spaceId, refreshFollows])

  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    const ok = await saveWatch({
      title: title.trim(),
      kind,
      spaceId: spaceId ?? null,
      cadence: 'interval',
      intervalMinutes: minutes,
      resultPlace: place.trim() || t('space.follow.defaultPlace'),
      notifyOn: 'change',
      /* 用户自己建的默认就启用（与模型提议不同） */
      enabled: true
    })
    if (ok) {
      setTitle('')
      setPlace('')
      setDraftOpen(false)
    }
  }

  const lookNow = (id: string): void => {
    const view = views.find((v) => v.watch.id === id)
    if (!view) return
    insertIntoComposer([
      `按这个关注看一遍：${view.watch.title}`,
      `关注类型：${FOLLOW_KIND_LABELS[view.watch.kind]}`,
      `上次看：${view.watch.lastCheckedAt ? formatWhen(view.watch.lastCheckedAt) : '还没看过'}`,
      `结果记到：${view.watch.resultPlace}`,
      '',
      FOLLOW_APP_ONLY_NOTE,
      '看完请回报：这次是「没有变化 / 有变化 / 需要我定 / 没看成」，以及具体变了什么。'
    ].join('\n'))
  }

  return (
    <div className="wb-follow" data-testid="space-ov-follow">
      <p className="wb-card-meta wb-follow-note" data-testid="space-follow-note">
        {t('space.follow.appOnly')}
      </p>

      {views.length === 0 ? (
        <p className="wb-card-empty" data-testid="space-follow-empty">
          {t('space.follow.empty')}
        </p>
      ) : (
        <ul className="wb-follow-list">
          {views.map((view) => (
            <li key={view.watch.id} className="wb-follow-item" data-testid={`space-follow-${view.watch.id}`}>
              <button
                className="wb-follow-row"
                data-testid={`space-follow-open-${view.watch.id}`}
                onClick={() => lookNow(view.watch.id)}
                title={t('space.follow.lookHint')}
              >
                <Icon name="history" size={12} />
                <span className="wb-follow-title">{view.watch.title}</span>
                <span className="wb-follow-status" data-testid={`space-follow-status-${view.watch.id}`}>
                  {view.status}
                </span>
              </button>
              {view.lastRunText ? (
                <p className="wb-card-meta" data-testid={`space-follow-last-${view.watch.id}`}>
                  {view.lastRunText}
                </p>
              ) : null}
              {view.proposed ? (
                <p className="wb-card-meta wb-follow-warn" data-testid={`space-follow-proposed-${view.watch.id}`}>
                  {t('space.follow.proposed')}
                </p>
              ) : null}
              <div className="wb-follow-actions">
                {view.watch.enabled ? (
                  <button
                    className="wb-btn"
                    data-testid={`space-follow-pause-${view.watch.id}`}
                    onClick={() => void updateWatch({ id: view.watch.id, enabled: false })}
                  >
                    {t('space.follow.pause')}
                  </button>
                ) : (
                  <button
                    className="wb-btn primary"
                    data-testid={`space-follow-enable-${view.watch.id}`}
                    onClick={() => void updateWatch({ id: view.watch.id, enabled: true })}
                  >
                    {t('space.follow.enable')}
                  </button>
                )}
                <button
                  className="wb-btn"
                  data-testid={`space-follow-remove-${view.watch.id}`}
                  onClick={() => void removeWatch(view.watch.id)}
                >
                  {t('space.follow.remove')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {due.length > 0 ? (
        <p className="wb-card-meta wb-follow-due" data-testid="space-follow-due">
          {t('space.follow.due', { count: due.length })}
        </p>
      ) : null}

      {draftOpen ? (
        <div className="wb-follow-draft" data-testid="space-follow-draft">
          <input
            className="wb-ex-input"
            data-testid="space-follow-new-title"
            value={title}
            placeholder={t('space.follow.newTitle')}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select
            className="wb-ex-input"
            data-testid="space-follow-new-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as FollowKind)}
          >
            {(Object.keys(FOLLOW_KIND_LABELS) as FollowKind[]).map((k) => (
              <option key={k} value={k}>
                {FOLLOW_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <select
            className="wb-ex-input"
            data-testid="space-follow-new-every"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {PRESET_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m === 1440 ? t('space.follow.everyDay') : m === 4320 ? t('space.follow.every3Days') : t('space.follow.everyWeek')}
              </option>
            ))}
          </select>
          <input
            className="wb-ex-input"
            data-testid="space-follow-new-place"
            value={place}
            placeholder={t('space.follow.newPlace')}
            onChange={(e) => setPlace(e.target.value)}
          />
          <div className="wb-follow-actions">
            <button className="wb-btn primary" data-testid="space-follow-new-save" onClick={() => void submit()}>
              {t('space.follow.save')}
            </button>
            <button className="wb-btn" data-testid="space-follow-new-cancel" onClick={() => setDraftOpen(false)}>
              {t('space.follow.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="wb-btn wb-follow-add" data-testid="space-follow-new" onClick={() => setDraftOpen(true)}>
          <Icon name="plus" size={12} />
          {t('space.follow.new')}
        </button>
      )}
    </div>
  )
}
