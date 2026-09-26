import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import {
  PLAYBOOK_KIND_LABELS,
  STEP_EFFECT_LABELS,
  parseStepLines,
  playbookRunNote,
  scopeSummary,
  stepScopeUnfilled,
  type Playbook,
  type PlaybookStep
} from '../../../../shared/playbook'

/**
 * 办事模板（实施-25 P14）。
 *
 * 界面上最要紧的一件事：**复用前把「会动哪里」摊开**（T14-3）。
 * 所以点开一个模板不会立刻做任何事，只会经 `planPlaybook` 拿到
 * 需要确认的步骤与作用范围；范围没填完就不能「填到输入框」。
 *
 * 第二个要点：连「填到输入框」也不发送 —— 它只把说明放进编排输入框，
 * 用户自己看完再按发送。界面上没有一个能替用户按下发送的按钮。
 */
export function PlaybookPanel(): React.JSX.Element {
  const t = useT()
  const playbooks = useStore((s) => s.playbooks)
  const plan = useStore((s) => s.playbookPlan)
  const planPlaybook = useStore((s) => s.planPlaybook)
  const clearPlaybookPlan = useStore((s) => s.clearPlaybookPlan)
  const recordRun = useStore((s) => s.recordPlaybookRun)
  const insertIntoComposer = useStore((s) => s.insertIntoComposer)
  const savePlaybook = useStore((s) => s.savePlaybook)
  const removePlaybook = useStore((s) => s.removePlaybook)

  const [openId, setOpenId] = useState<string | null>(null)
  /* 每个需要确认的步骤一组范围（下标与需要确认的步骤顺序一致） */
  const [scopes, setScopes] = useState<string[][]>([])
  const [draftOpen, setDraftOpen] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftGoal, setDraftGoal] = useState('')
  const [draftSteps, setDraftSteps] = useState('')
  const [draftError, setDraftError] = useState('')

  const open = openId ? playbooks.find((p) => p.id === openId) ?? null : null

  /*
   * 打开模板时先问一次「会动哪里」：范围预填模板里已有的值
   * （起步模板是 `<要整理的目录>` 这种占位 —— 用户把它换成真实路径才算填完）。
   */
  useEffect(() => {
    if (!openId) return
    void planPlaybook({ id: openId })
  }, [openId, planPlaybook])

  useEffect(() => {
    if (!plan?.points) {
      setScopes([])
      return
    }
    setScopes(plan.points.map((step) => step.scope ?? []))
  }, [plan?.points, plan?.playbook?.id])

  const summary = open ? scopeSummary(open.steps) : null
  /*
   * 「还没填」的判据与宿主同源（占位写法也算没填）：
   * 否则用户点一下就把「<要整理的目录>」这句话发出去了。
   */
  const unanswered =
    plan?.points?.filter((step, i) => stepScopeUnfilled({ ...step, scope: scopes[i] ?? step.scope ?? [] })).length ?? 0

  const recheck = (): void => {
    if (!open) return
    void planPlaybook({ id: open.id, scopes })
  }

  const use = (): void => {
    if (!plan?.text || !open) return
    void recordRun(open.id)
    insertIntoComposer(plan.text)
    setOpenId(null)
    clearPlaybookPlan()
  }

  const submitDraft = async (): Promise<void> => {
    const parsed = parseStepLines(draftSteps)
    if (!parsed.ok) {
      setDraftError(parsed.message)
      return
    }
    if (!draftTitle.trim()) {
      setDraftError(t('space.pb.needTitle'))
      return
    }
    if (!draftGoal.trim()) {
      setDraftError(t('space.pb.needGoal'))
      return
    }
    setDraftError('')
    const ok = await savePlaybook({
      kind: 'custom',
      title: draftTitle.trim(),
      goal: draftGoal.trim(),
      steps: parsed.steps,
      origin: 'user'
    })
    if (ok) {
      setDraftOpen(false)
      setDraftTitle('')
      setDraftGoal('')
      setDraftSteps('')
    }
  }

  const effectTag = (step: PlaybookStep): React.JSX.Element => (
    <span className={`wb-pb-effect ${step.effect}`} data-testid={`space-pb-effect-${step.effect}`}>
      {STEP_EFFECT_LABELS[step.effect]}
    </span>
  )

  const renderSteps = (pb: Playbook): React.JSX.Element => (
    <ol className="wb-pb-steps">
      {pb.steps.map((step, i) => (
        <li key={`${pb.id}-${i}`} data-testid={`space-pb-step-${i}`}>
          {effectTag(step)}
          <span className="wb-pb-step-title">{step.title}</span>
        </li>
      ))}
    </ol>
  )

  return (
    <div className="wb-pb" data-testid="space-ov-playbooks">
      <ul className="wb-pb-list">
        {playbooks.map((pb) => (
          <li key={pb.id}>
            <button
              className={`wb-pb-row ${openId === pb.id ? 'on' : ''}`}
              data-testid={`space-pb-item-${pb.id}`}
              onClick={() => setOpenId(openId === pb.id ? null : pb.id)}
            >
              <Icon name="layers" size={12} />
              <span className="wb-pb-title">{pb.title}</span>
              <span className="wb-list-meta">
                {PLAYBOOK_KIND_LABELS[pb.kind]}
                {pb.seeded ? ` · ${t('space.pb.seed')}` : ''}
              </span>
              <span className="wb-list-meta">{playbookRunNote(pb)}</span>
            </button>

            {/* 复用前的确认区（T14-3）：只解释，不执行 */}
            {openId === pb.id && plan?.playbook?.id === pb.id && plan.points ? (
              <div className="wb-pb-zone" data-testid={`space-pb-zone-${pb.id}`}>
                <p className="wb-pb-confirm" data-testid="space-pb-confirm">
                  {plan.confirmationText}
                </p>
                {/* 全部步骤（含只读）—— 确认之前先看完整一遍 */}
                {renderSteps(pb)}
                <ul className="wb-pb-points">
                  {plan.points.map((step, i) => (
                    <li key={`${pb.id}-point-${i}`} data-testid={`space-pb-point-${i}`}>
                      <span className="wb-pb-point-title">
                        {effectTag(step)}
                        {step.title}
                      </span>
                      <input
                        className="wb-ex-input"
                        data-testid={`space-pb-scope-${i}`}
                        value={(scopes[i] ?? []).join('、')}
                        placeholder={t('space.pb.scopePlaceholder')}
                        onChange={(e) => {
                          const next = [...scopes]
                          next[i] = e.target.value
                            .split(/[、,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                          setScopes(next)
                        }}
                      />
                    </li>
                  ))}
                </ul>
                {unanswered > 0 ? (
                  <p className="wb-card-meta wb-pb-warn" data-testid="space-pb-unanswered">
                    {t('space.pb.unanswered', { count: unanswered })}
                  </p>
                ) : null}
                <div className="wb-pb-actions">
                  <button className="wb-btn" data-testid="space-pb-recheck" onClick={recheck}>
                    <Icon name="refresh" size={12} />
                    {t('space.pb.recheck')}
                  </button>
                  <button
                    className="wb-btn primary"
                    data-testid="space-pb-use"
                    disabled={unanswered > 0}
                    title={t('space.pb.useHint')}
                    onClick={use}
                  >
                    <Icon name="send" size={12} />
                    {t('space.pb.use')}
                  </button>
                  <button
                    className="wb-btn"
                    data-testid="space-pb-close"
                    onClick={() => {
                      setOpenId(null)
                      clearPlaybookPlan()
                    }}
                  >
                    {t('space.pb.close')}
                  </button>
                  {!pb.seeded ? (
                    <button
                      className="wb-btn"
                      data-testid="space-pb-remove"
                      onClick={() => void removePlaybook(pb.id)}
                    >
                      {t('space.pb.remove')}
                    </button>
                  ) : null}
                </div>
                <p className="wb-card-meta wb-pb-note" data-testid="space-pb-note">
                  {t('space.pb.useNote')}
                </p>
              </div>
            ) : null}

            {openId === pb.id && !plan ? (
              <div className="wb-pb-zone">
                <p className="wb-card-meta">{t('space.pb.loading')}</p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {summary ? (
        <p className="wb-card-meta" data-testid="space-pb-summary">
          {t('space.pb.summary', { read: summary.read, write: summary.write, external: summary.external })}
        </p>
      ) : null}

      {/* 手存一份：三行文字（每行一步），校验仍走 shared 的同一份规则 */}
      {draftOpen ? (
        <div className="wb-pb-draft" data-testid="space-pb-draft">
          <input
            className="wb-ex-input"
            data-testid="space-pb-new-title"
            value={draftTitle}
            placeholder={t('space.pb.newTitle')}
            onChange={(e) => setDraftTitle(e.target.value)}
          />
          <input
            className="wb-ex-input"
            data-testid="space-pb-new-goal"
            value={draftGoal}
            placeholder={t('space.pb.newGoal')}
            onChange={(e) => setDraftGoal(e.target.value)}
          />
          <textarea
            className="wb-ex-input wb-pb-steps-input"
            data-testid="space-pb-new-steps"
            value={draftSteps}
            rows={3}
            placeholder={t('space.pb.newSteps')}
            onChange={(e) => setDraftSteps(e.target.value)}
          />
          {draftError ? (
            <p className="wb-card-meta wb-pb-warn" data-testid="space-pb-new-error">
              {draftError}
            </p>
          ) : null}
          <div className="wb-pb-actions">
            <button className="wb-btn primary" data-testid="space-pb-new-save" onClick={() => void submitDraft()}>
              {t('space.pb.save')}
            </button>
            <button className="wb-btn" data-testid="space-pb-new-cancel" onClick={() => setDraftOpen(false)}>
              {t('space.pb.close')}
            </button>
          </div>
        </div>
      ) : (
        <button className="wb-btn wb-pb-add" data-testid="space-pb-new" onClick={() => setDraftOpen(true)}>
          <Icon name="plus" size={12} />
          {t('space.pb.new')}
        </button>
      )}
    </div>
  )
}
