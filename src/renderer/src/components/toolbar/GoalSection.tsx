import { useEffect } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type MessageKey } from '../../i18n'
import type { GoalState } from '../../../../shared/ipc'
import { useStore } from '../../state/store'

const PHASE_LABEL: Record<GoalState['phase'], MessageKey> = {
  planning: 'goal.planning',
  executing: 'goal.executing',
  verifying: 'goal.verifying',
  completed: 'goal.completed',
  blocked: 'goal.blocked',
  stopped: 'goal.stopped'
}

/**
 * 砚内置的目标 / 计划面板。
 *
 * 它不属于可拖拽的扩展工具分区：目标是宿主按会话维护的事实状态，
 * 自主模式会从用户指令自动建立它，模型只能通过 `yan goal report` 推进。
 * 这样用户能看到“砚正在按什么计划做”，又不会给 UI 增加第二条写入目标的链路。
 */
export function GoalSection() {
  const t = useT()
  const goal = useStore((s) => s.goal)
  const mode = useStore((s) => s.workMode?.mode)
  const loadGoal = useStore((s) => s.loadGoal)

  useEffect(() => {
    void loadGoal()
  }, [loadGoal])

  const activeGoal = goal?.goalId ? goal : null
  const hasGoal = activeGoal !== null
  const steps = activeGoal?.steps ?? []
  const done = steps.filter((step) => step.status === 'done').length

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
        {activeGoal ? <span className="goal-panel-phase">{t(PHASE_LABEL[activeGoal.phase])}</span> : null}
      </div>

      {!hasGoal ? (
        <div className="goal-panel-empty">
          <span>{t('goal.empty')}</span>
          <small>{mode === 'autonomous' ? t('goal.autonomousHint') : t('goal.modeHint')}</small>
        </div>
      ) : (
        <div className="goal-panel-content">
          <div className="goal-panel-meta">
            <span>{t('goal.revision', { n: activeGoal.revision })}</span>
            {steps.length ? <span>{t('goal.progress', { done, total: steps.length })}</span> : null}
          </div>

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

          {activeGoal.evidence.length ? (
            <div className="goal-panel-evidence">
              <div className="goal-panel-subtitle">{t('goal.evidence')}</div>
              {activeGoal.evidence.slice(-3).map((item, index) => (
                <div className="goal-evidence-row" key={`${index}-${item}`}>{item}</div>
              ))}
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
