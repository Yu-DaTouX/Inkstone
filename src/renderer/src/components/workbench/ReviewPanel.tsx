import { useEffect } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Icon } from '../../icons/Icon'
import { dueReviews, reviewReasonLabel, reviewRuleText, reviewWhenText } from '../../../../shared/review'

/**
 * 错题与复习（实施-25 P12）。
 *
 * ── 这里只做两件事 ──
 * 1. **提醒**：什么时候再看一眼（到期 / 优先 / 来因）；
 * 2. **挑题**：「今天十分钟」把要练的挑出来 —— 同概念换新例子，不复用做过的原题。
 *
 * 不在这里「开始学习」：点了题也只是把这道题放到练习卡里，做不做、什么时候做
 * 由用户决定。**复习不自动代学**是这一片对着 P12 验收写的边界。
 *
 * 文案上也刻意不说「该复习了＝快忘了」：间隔是排期，不是记忆强度的测量。
 */
const DAY_MS = 86400000

interface Props {
  courseId: string
}

export function ReviewPanel({ courseId }: Props): React.JSX.Element {
  const t = useT()
  const reviews = useStore((s) => s.reviews)
  const plan = useStore((s) => s.reviewPlan)
  const refresh = useStore((s) => s.refreshReviews)
  const planReviews = useStore((s) => s.planReviews)
  const reschedule = useStore((s) => s.rescheduleReview)
  const dismiss = useStore((s) => s.dismissReview)
  const focusExercise = useStore((s) => s.focusExercise)

  useEffect(() => {
    if (!courseId) return
    void refresh(courseId)
    void planReviews(courseId, 'due')
  }, [courseId])

  const now = Date.now()
  const due = dueReviews(reviews, now)
  const listed = [...reviews].sort((a, b) => a.dueAt - b.dueAt)

  const openExercise = async (exerciseId: string): Promise<void> => {
    await focusExercise(exerciseId)
  }

  return (
    <section className="wb-memory wb-memory-panel" data-testid="space-learn-review">
      <header className="wb-memory-head">
        <h4 className="wb-memory-title">{t('space.review.title')}</h4>
        <span className="wb-memory-count" data-testid="space-learn-review-due">
          {t('space.review.dueCount', { n: due.length })}
        </span>
      </header>
      <p className="wb-card-meta" data-testid="space-learn-review-rule">
        {reviewRuleText()}
      </p>

      {listed.length === 0 ? (
        <p className="wb-card-empty" data-testid="space-learn-review-empty">
          {t('space.review.empty')}
        </p>
      ) : (
        <>
          <div className="wb-memory-acts">
            <button
              className="btn sm wb-memory-act"
              data-testid="space-learn-review-quick"
              onClick={() => void planReviews(courseId, 'quick')}
            >
              <Icon name="history" size={12} />
              {t('space.review.quick', { n: 10 })}
            </button>
          </div>

          {plan && plan.entries.length > 0 ? (
            <div className="wb-memory-plan" data-testid="space-learn-review-plan">
              <p className="wb-card-meta">
                {t('space.review.planHead', { n: plan.entries.length, minutes: plan.minutes })}
              </p>
              {plan.entries.map((entry, index) => (
                <div key={entry.item.id} className="wb-memory-plan-row" data-testid={`space-learn-review-plan-item-${index}`}>
                  <span className="wb-memory-plan-text">{entry.item.prompt}</span>
                  {entry.exerciseId ? (
                    <button
                      className="btn sm wb-memory-act"
                      data-testid={`space-learn-review-plan-open-${index}`}
                      onClick={() => void openExercise(entry.exerciseId as string)}
                    >
                      {t('space.review.open')}
                    </button>
                  ) : (
                    <span className="wb-card-meta" data-testid={`space-learn-review-plan-reading-${index}`}>
                      {t('space.review.reread')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {plan && plan.needsNewExercise.length > 0 ? (
            <p className="wb-card-meta wb-memory-note" data-testid="space-learn-review-needs-new">
              {t('space.review.needsNew', { n: plan.needsNewExercise.length })}
            </p>
          ) : null}

          <ul className="wb-memory-list" data-testid="space-learn-review-list">
            {listed.map((item) => (
              <li key={item.id} className="wb-memory-row" data-testid={`space-learn-review-item-${item.id}`}>
                <div className="wb-memory-row-head">
                  <span className="wb-memory-name">{item.prompt}</span>
                  <span
                    className={`wb-memory-badge ${item.priority === 'high' ? 'attn' : 'calm'}`}
                    data-testid={`space-learn-review-reason-${item.id}`}
                  >
                    {reviewReasonLabel(item.reason)}
                  </span>
                  <span className="wb-memory-when" data-testid={`space-learn-review-when-${item.id}`}>
                    {reviewWhenText(item, now)}
                  </span>
                </div>
                <div className="wb-memory-acts">
                  <button
                    className="btn sm wb-memory-act"
                    data-testid={`space-learn-review-tomorrow-${item.id}`}
                    onClick={() => void reschedule(item.id, { dueAt: now + DAY_MS })}
                  >
                    {t('space.review.tomorrow')}
                  </button>
                  <button
                    className="btn sm wb-memory-act"
                    data-testid={`space-learn-review-now-${item.id}`}
                    onClick={() => void reschedule(item.id, { dueAt: now, priority: 'high' })}
                  >
                    {t('space.review.now')}
                  </button>
                  <button
                    className="btn sm wb-memory-act"
                    data-testid={`space-learn-review-dismiss-${item.id}`}
                    onClick={() => void dismiss(item.id, courseId)}
                  >
                    {t('space.review.dismiss')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
