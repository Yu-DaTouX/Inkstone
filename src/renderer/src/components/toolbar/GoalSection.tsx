import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type MessageKey } from '../../i18n'
import type { GoalLink, GoalState } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import { goalDisplayTitle } from '../../state/goal-view'
import { Button } from '../ui'

const PHASE_LABEL: Record<GoalState['phase'], MessageKey> = {
  planning: 'goal.planning',
  executing: 'goal.executing',
  verifying: 'goal.verifying',
  completed: 'goal.completed',
  blocked: 'goal.blocked',
  stopped: 'goal.stopped'
}

const VERIFICATION_LABEL: Record<NonNullable<GoalState['verification']>['status'], MessageKey> = {
  not_checked: 'goal.verNotChecked',
  passed: 'goal.verPassed',
  failed: 'goal.verFailed',
  manual_review: 'goal.verManual'
}

export function GoalContent() {
  const t = useT()
  const goal = useStore((s) => s.goal)
  const mode = useStore((s) => s.workMode?.mode)
  const loadGoal = useStore((s) => s.loadGoal)
  const goalLoading = useStore((s) => s.goalLoading)
  const goalError = useStore((s) => s.goalError)
  const setGoalReadyApproval = useStore((s) => s.setGoalReadyApproval)
  const approveGoalReady = useStore((s) => s.approveGoalReady)
  const modifyGoalReady = useStore((s) => s.modifyGoalReady)
  const [briefExpanded, setBriefExpanded] = useState(false)

  useEffect(() => {
    void loadGoal()
  }, [loadGoal])

  const activeGoal = goal?.goalId ? goal : null
  const pendingReady = goal?.pendingReady ?? null
  const hasGoal = activeGoal !== null
  const steps = activeGoal?.steps ?? []
  const done = steps.filter((step) => step.status === 'done').length
  const [linkError, setLinkError] = useState<string | null>(null)

  const openLink = useCallback(
    async (link: GoalLink) => {
      setLinkError(null)
      if (link.check && !link.check.ok) {
        setLinkError(link.check.detail)
        return
      }
      try {
        if (link.kind === 'url') {
          const res = await window.yan.browser.openExternal(link.target)
          if (!res.ok) setLinkError(res.error ?? t('goal.linkFailed'))
          return
        }
        const res = await window.yan.openPath(link.target)
        if (!res.ok) setLinkError(t('goal.linkFailed'))
      } catch (error) {
        setLinkError(error instanceof Error ? error.message : t('goal.linkFailed'))
      }
    },
    [t]
  )

  return (
    <section
      className={`goal-panel ${activeGoal ? `goal-${activeGoal.phase}` : 'goal-empty-state'}`}
      data-testid="goal-panel"
      data-goal-phase={activeGoal?.phase ?? 'empty'}
    >
      <div className="goal-panel-head">
        <div className="goal-panel-title">
          <Icon name="checklist" size={14} />
          <span>{t('goal.title')}</span>
        </div>
        {activeGoal?.pursue ? (
          <span className="goal-panel-pursue" data-testid="goal-pursue" title={t('goal.pursueHint')}>
            {t('goal.pursue')}
          </span>
        ) : null}
        {activeGoal ? <span className="goal-panel-phase">{t(PHASE_LABEL[activeGoal.phase])}</span> : null}
      </div>

      {mode === 'clarify' ? (
        <div className="goal-review-setting" data-testid="goal-review-setting">
          <label>
            <input
              type="checkbox"
              checked={goal?.readyApproval === 'review'}
              disabled={!goal || goalLoading || !!pendingReady}
              onChange={(event) => void setGoalReadyApproval(event.target.checked ? 'review' : 'automatic')}
              data-testid="goal-review-setting-toggle"
            />
            <span>{t('goal.reviewSetting')}</span>
          </label>
          <small>{t('goal.reviewSettingHint')}</small>
        </div>
      ) : null}

      {pendingReady ? (
        <div className="goal-review-pending" data-testid="goal-pending-review">
          <div className="goal-panel-subtitle">{t('goal.pendingReview')}</div>
          <div className="goal-review-fields">
            <div><span>{t('goal.readyGoal')}</span><strong>{pendingReady.understanding.goal}</strong></div>
            <div><span>{t('goal.readyDeliverable')}</span><strong>{pendingReady.understanding.deliverable}</strong></div>
            <div><span>{t('goal.readyScope')}</span><strong>{pendingReady.understanding.scope}</strong></div>
            <div><span>{t('goal.readyConstraints')}</span><strong>{pendingReady.understanding.constraints}</strong></div>
            <div><span>{t('goal.readyAcceptance')}</span><strong>{pendingReady.understanding.acceptance}</strong></div>
          </div>
          <small>{t('goal.reviewReadOnly')}</small>
          <div className="goal-review-actions">
            <Button variant="primary" size="sm" className="sa-act-btn" type="button" onClick={() => void approveGoalReady()} disabled={goalLoading || mode !== 'clarify'} data-testid="goal-approve-and-start">
              {t('goal.approveAndStart')}
            </Button>
            <Button size="sm" className="sa-act-btn" type="button" onClick={() => void modifyGoalReady()} disabled={goalLoading || mode !== 'clarify'} data-testid="goal-modify-plan">
              {t('goal.modifyPlan')}
            </Button>
          </div>
        </div>
      ) : null}

      {!hasGoal ? (
        goalError ? (
          <div className="goal-panel-empty goal-panel-error" data-testid="goal-error">
            <span>{t('goal.loadFailed')}</span>
            <small title={goalError}>{goalError}</small>
            <Button size="sm" className="sa-act-btn" type="button" onClick={() => void loadGoal()} data-testid="goal-retry">
              {t('goal.retry')}
            </Button>
          </div>
        ) : goalLoading ? (
          <div className="goal-panel-empty" data-testid="goal-loading">
            <span>{t('goal.loading')}</span>
          </div>
        ) : (
          <div className="goal-panel-empty">
            <span>{t('goal.empty')}</span>
            <small>{mode === 'autonomous' ? t('goal.autonomousHint') : t('goal.modeHint')}</small>
          </div>
        )
      ) : (
        <div className="goal-panel-content">
          {!activeGoal.brief && goalDisplayTitle(activeGoal) ? (
            <div className="goal-panel-display-title" data-testid="goal-display-title">{goalDisplayTitle(activeGoal)}</div>
          ) : null}
          {activeGoal.brief ? (
            <div className={`goal-brief ${briefExpanded ? 'expanded' : ''}`} data-testid="goal-brief">
              <div className="goal-brief-row">
                <span className="goal-brief-key">{t('goal.briefGoal')}</span>
                <span className="goal-brief-value">{activeGoal.brief.goal}</span>
              </div>
              <div className="goal-brief-row">
                <span className="goal-brief-key">{t('goal.briefOutcome')}</span>
                <span className="goal-brief-value">{activeGoal.brief.outcome}</span>
              </div>
              {activeGoal.brief.deliverable ? (
                <div className="goal-brief-row" data-testid="goal-brief-deliverable">
                  <span className="goal-brief-key">{t('goal.briefDeliverable')}</span>
                  <span className="goal-brief-value">{activeGoal.brief.deliverable}</span>
                </div>
              ) : null}
              {activeGoal.brief.scope ? (
                <div className="goal-brief-row" data-testid="goal-brief-scope">
                  <span className="goal-brief-key">{t('goal.briefScope')}</span>
                  <span className="goal-brief-value">{activeGoal.brief.scope}</span>
                </div>
              ) : null}
              {activeGoal.brief.constraints ? (
                <div className="goal-brief-row" data-testid="goal-brief-constraints">
                  <span className="goal-brief-key">{t('goal.briefConstraints')}</span>
                  <span className="goal-brief-value">{activeGoal.brief.constraints}</span>
                </div>
              ) : null}
              {[
                activeGoal.brief.goal,
                activeGoal.brief.outcome,
                activeGoal.brief.deliverable,
                activeGoal.brief.scope,
                activeGoal.brief.constraints
              ].join('').length > 140 ? (
                <button
                  type="button"
                  className="goal-brief-toggle"
                  data-testid="goal-brief-toggle"
                  aria-expanded={briefExpanded}
                  onClick={() => setBriefExpanded((v) => !v)}
                >
                  {briefExpanded ? t('goal.collapse') : t('goal.expand')}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="goal-panel-meta">
            <span>{t('goal.revision', { n: activeGoal.revision })}</span>
            {steps.length ? <span>{t('goal.progress', { done, total: steps.length })}</span> : null}
          </div>

          {activeGoal.phase === 'completed' ? (
            <div className="goal-panel-claim" data-testid="goal-model-claim">
              {t('goal.modelClaim')}
            </div>
          ) : null}

          {activeGoal.verification ? (
            <div className="goal-panel-verification" data-testid="goal-verification">
              <div className="goal-panel-subtitle">{t('goal.verificationTitle')}</div>
              <div
                className={`goal-verification-status goal-verification-${activeGoal.verification.status}`}
                data-testid="goal-verification-status"
                data-verification-status={activeGoal.verification.status}
              >
                {t(VERIFICATION_LABEL[activeGoal.verification.status])}
              </div>
              <div className="goal-verification-detail">{activeGoal.verification.detail}</div>
              {activeGoal.verification.checks.length ? (
                <div className="goal-verification-checks">
                  {activeGoal.verification.checks.slice(0, 6).map((check, index) => (
                    <div
                      className={`goal-verification-check${check.ok ? '' : ' goal-verification-check-bad'}`}
                      data-testid="goal-verification-check"
                      data-check-ok={String(check.ok)}
                      key={`${check.kind}-${check.target}-${index}`}
                      title={`${check.target}\n${check.detail}`}
                    >
                      <Icon name={check.ok ? 'check-circle' : 'alert-circle'} size={12} />
                      <span className="goal-verification-target">{check.target}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {steps.length ? (
            <ol className="goal-steps">
              {steps.map((step, index) => (
                <GoalStepRow key={`${index}-${step.title}`} step={step} index={index} />
              ))}
            </ol>
          ) : (
            <div className="goal-panel-pending">{t('goal.noSteps')}</div>
          )}

          {activeGoal.blocker ? (
            <div className="goal-panel-blocker">
              <Icon name="alert-circle" size={12} />
              <span>{activeGoal.blocker}</span>
            </div>
          ) : null}

          {(activeGoal.evidence ?? []).length ? (
            <details className="goal-panel-evidence">
              <summary className="goal-panel-subtitle">{t('goal.evidence')} · {activeGoal.evidence.length}</summary>
              {(activeGoal.evidence ?? []).slice(-3).map((item, index) => (
                <div className="goal-evidence-row" key={`${index}-${item}`}>{item}</div>
              ))}
            </details>
          ) : null}

          {(activeGoal.links ?? []).length ? (
            <div className="goal-panel-links" data-testid="goal-links">
              <div className="goal-panel-subtitle">{t('goal.links')}</div>
              {(activeGoal.links ?? []).slice(-6).map((link, index) => (
                <button
                  type="button"
                  className={`goal-link-row${link.check && !link.check.ok ? ' goal-link-row-bad' : ''}`}
                  data-testid="goal-link-row"
                  data-link-kind={link.kind}
                  data-link-ok={link.check ? String(link.check.ok) : 'unchecked'}
                  key={`${link.kind}-${link.target}-${index}`}
                  title={link.check ? `${link.target}\n${t('goal.hostCheck', { detail: link.check.detail })}` : link.target}
                  onClick={() => void openLink(link)}
                >
                  <Icon name={link.kind === 'url' ? 'globe' : 'folder-open'} size={12} />
                  <span className="goal-link-label">{link.label || link.target}</span>
                  <span className="goal-link-kind">{link.kind}</span>
                </button>
              ))}
            </div>
          ) : null}

          {activeGoal.budget || activeGoal.budgetStop ? (
            <div className="goal-panel-budget" data-testid="goal-budget">
              <div className="goal-panel-subtitle">{t('goal.budget')}</div>
              {activeGoal.budget?.tokens ? (
                <div className="goal-budget-row" data-testid="goal-budget-tokens">
                  {typeof activeGoal.budgetUsage?.tokens === 'number'
                    ? t('goal.budgetTokensUsed', { used: activeGoal.budgetUsage.tokens, cap: activeGoal.budget.tokens })
                    : t('goal.budgetTokensUnknown', { cap: activeGoal.budget.tokens })}
                </div>
              ) : null}
              {activeGoal.budget?.ms ? (
                <div className="goal-budget-row">
                  {t('goal.budgetTime', { n: Math.round(activeGoal.budget.ms / 60000) })}
                </div>
              ) : null}
              {activeGoal.budgetStop ? (
                <div className="goal-budget-stop" data-testid="goal-budget-stop">
                  {activeGoal.budgetStop.detail}
                </div>
              ) : null}
            </div>
          ) : null}

          {linkError ? (
            <div className="goal-panel-blocker" data-testid="goal-link-error">
              <Icon name="alert-circle" size={12} />
              <span>{linkError}</span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

function GoalStepRow({ step, index }: { step: GoalState['steps'][number]; index: number }) {
  const icon = step.status === 'done'
    ? <Icon name="check-circle" size={12} />
    : step.status === 'blocked'
      ? <Icon name="alert-circle" size={12} />
      : <span className="goal-step-dot" aria-hidden />

  return (
    <li className={`goal-step goal-step-${step.status}`}>
      <span className="goal-step-icon" aria-hidden>{icon}</span>
      <span className="goal-step-index">{index + 1}</span>
      <span className="goal-step-title" title={step.title}>{step.title}</span>
    </li>
  )
}
