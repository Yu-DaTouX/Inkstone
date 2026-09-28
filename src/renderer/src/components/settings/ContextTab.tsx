import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { CONTEXT_POLICY_PRESETS, LARGE_CONTEXT_POLICY_PRESETS, largePresetOf } from '../../../../shared/context-policy'
import type { ContextPolicyOverrides } from '../../../../shared/ipc'
import {
  CONTEXT_BUDGET_V1_TIERS,
  type ContextBudgetRuntimeSnapshotV1,
  type ContextBudgetSessionPolicyV1,
  type ContextBudgetTierV1
} from '../../../../shared/context-budget-v1'
import type { ContextMaintenanceOperationV1 } from '../../../../shared/context-maintenance'
import type { ContextBackgroundUsageSummary } from '../../../../shared/context-background-usage'
import { SettingRow } from '../ui'

/**
 * 「上下文」设置页（N21-7）。
 *
 * 把此前只存在于代码里的工作集数值变成用户可改、可解释的一组值：
 *   · **预设**：砚默认（已验证的 240k / 70%）与参考方案（300k / 75%）；
 *   · **用户级**：三个数值覆盖（留空 = 用默认）；
 *   · **模型级**：只为当前模型覆盖（`provider/model`），切模型各用各的；
 *   · **生效来源**：显示这份数值是哪一层定的（默认 / 用户 / 供应商 / 模型 / 环境变量）。
 *
 * 为什么只暴露三个字段：它们是参考方案 §16.4 明确要求 profile 化的三个
 * （`workingSetCap` / `workingSetRatio` / `responseReserve`），也是真正会影响
 * “什么时候动手”的三个。其余字段（安全余量、兜底比例、阶段刻度）仍可在
 * `desktop.json` 里手写，但界面上不给 —— 一排数字里挑错一个的代价太大，
 * 而它们极少需要改。
 *
 * 为什么草稿 + 显式保存而不是每键写盘：数值输入中间态（例如刚删成空串）
 * 不是合法设置，逐键 patchSettings 会写进一堆半成品，同时每键一次 IPC。
 */
export function ContextTab() {
  const t = useT()
  /* 生效层 / 字段名是运行期拼出来的 key（`set.ctxSource.model` 这类），
     而 i18n 的 key 是编译期联合类型 —— 这里集中断言一次，不要每处都写。 */
  const tk = (key: string): string => t(key as MessageKey)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const policy = useStore((s) => s.session?.contextPolicy)
  const model = useStore((s) => s.session?.model)
  const sessionId = useStore((s) => s.session?.sessionId)

  const user = settings?.contextPolicy ?? {}
  const byModel = settings?.contextPolicyByModel ?? {}
  const modelKey = model?.provider && model.id ? `${model.provider}/${model.id}` : undefined
  const modelOver = modelKey ? byModel[modelKey] : undefined
  const modelLargePreset = largePresetOf(modelOver)
  /* 只给有明确运行时窗口的当前模型显示试行档；登记值仍需用户自行确认。 */
  const largeWindowCandidate = (model?.contextWindow ?? 0) >= 800_000

  const [draft, setDraft] = useState(() => fields(user))
  const [modelDraft, setModelDraft] = useState(() => fields(modelOver))
  const [budgetV1, setBudgetV1] = useState<ContextBudgetSessionPolicyV1 | null>(null)
  const [budgetV1Enabled, setBudgetV1Enabled] = useState(false)
  const [budgetSnapshot, setBudgetSnapshot] = useState<ContextBudgetRuntimeSnapshotV1 | null>(null)
  const [budgetV1Error, setBudgetV1Error] = useState('')
  const [budgetV1Busy, setBudgetV1Busy] = useState(false)
  const [maintenanceBusy, setMaintenanceBusy] = useState(false)
  const [maintenanceMessage, setMaintenanceMessage] = useState('')
  const [maintenanceOperation, setMaintenanceOperation] = useState<ContextMaintenanceOperationV1 | null>(null)
  const [backgroundUsage, setBackgroundUsage] = useState<ContextBackgroundUsageSummary | null>(null)
  const refreshBackgroundUsage = async (): Promise<void> => {
    try {
      setBackgroundUsage(await window.yan.contextBackgroundUsage())
    } catch { /* 读数是诊断：拿不到就保留上一次读数，不报错 */ }
  }
  useEffect(() => {
    let current = true
    setBudgetV1(null)
    setBudgetV1Enabled(false)
    setBudgetSnapshot(null)
    setBudgetV1Error('')
    setMaintenanceMessage('')
    setMaintenanceOperation(null)
    setBackgroundUsage(null)
    if (!sessionId) return () => { current = false }
    void Promise.allSettled([
      window.yan.contextBudgetV1(),
      window.yan.contextBudgetV1Enabled(),
      window.yan.contextBudgetSnapshotV1(),
      window.yan.contextBudgetMaintenanceStatusV1()
    ]).then(([policyResult, enabledResult, snapshotResult, operationResult]) => {
      if (!current) return
      if (policyResult.status === 'fulfilled' && policyResult.value) setBudgetV1(policyResult.value)
      else setBudgetV1Error(tk('set.ctxBudgetV1Unavailable'))
      if (enabledResult.status === 'fulfilled') setBudgetV1Enabled(enabledResult.value)
      if (snapshotResult.status === 'fulfilled') setBudgetSnapshot(snapshotResult.value)
      if (operationResult.status === 'fulfilled') setMaintenanceOperation(operationResult.value)
    })
    void refreshBackgroundUsage()
    return () => { current = false }
  }, [sessionId])
  useEffect(() => {
    if (!sessionId) return
    let current = true
    let timer: ReturnType<typeof setInterval> | null = null
    const refresh = async (): Promise<void> => {
      try {
        const operation = await window.yan.contextBudgetMaintenanceStatusV1()
        if (!current) return
        setMaintenanceOperation(operation)
        if (operation && !['requested', 'preparing', 'summarizing', 'validating', 'committed'].includes(operation.state) && timer) {
          clearInterval(timer)
          timer = null
        }
      } catch { /* status is opportunistic; the persisted record remains authoritative */ }
    }
    void refresh()
    timer = setInterval(() => { void refresh() }, 1_500)
    return () => {
      current = false
      if (timer) clearInterval(timer)
    }
  }, [sessionId])
  /* 设置从别处变了（预设按钮 / 另一个窗口）要跟上，否则输入框显示旧值 */
  useEffect(() => setDraft(fields(settings?.contextPolicy)), [settings?.contextPolicy])
  useEffect(() => setModelDraft(fields(modelOver)), [modelKey, JSON.stringify(modelOver ?? null)])

  const saveUser = (): void => {
    void patchSettings({ contextPolicy: overridesFrom(draft) })
  }
  const saveModel = (): void => {
    if (!modelKey) return
    const next = { ...byModel }
    const o = overridesFrom(modelDraft)
    if (o) next[modelKey] = o
    else delete next[modelKey]
    void patchSettings({ contextPolicyByModel: next })
  }
  const removeModel = (key: string): void => {
    const next = { ...byModel }
    delete next[key]
    void patchSettings({ contextPolicyByModel: next })
  }
  const applyModelLargePreset = (preset: 'balanced' | 'long'): void => {
    if (!modelKey || !largeWindowCandidate) return
    const next = { ...byModel, [modelKey]: { ...LARGE_CONTEXT_POLICY_PRESETS[preset] } }
    setModelDraft(fields(next[modelKey]))
    void patchSettings({ contextPolicyByModel: next })
  }

  const activeBudgetPhase = budgetV1?.phases[budgetV1.activePhaseId]
  /* 过期就是不存在（与 store / 扩展同一判断）：不靠定时刷新来让提示消失 */
  const activeTemporaryOverride =
    activeBudgetPhase?.temporaryBudgetOverride && activeBudgetPhase.temporaryBudgetOverride.expiresAt > Date.now()
      ? activeBudgetPhase.temporaryBudgetOverride
      : null
  const budgetDecisionKey = budgetSnapshot
    ? `set.ctxBudgetV1Decision.${budgetSnapshot.check.decision}`
    : ''
  const budgetReasonKeys: Record<string, string> = {
    within_review_line: 'set.ctxBudgetV1ReasonWithin',
    soft_review_line_reached: 'set.ctxBudgetV1ReasonReview',
    hard_input_limit_exceeded: 'set.ctxBudgetV1ReasonHardLimit',
    request_input_count_unavailable: 'set.ctxBudgetV1ReasonCountUnknown',
    request_output_limit_unknown: 'set.ctxBudgetV1ReasonOutputUnknown',
    output_capacity_unknown: 'set.ctxBudgetV1ReasonOutputUnknown',
    context_window_unknown: 'set.ctxBudgetV1ReasonCapacityUnknown',
    endpoint_capability_unavailable: 'set.ctxBudgetV1ReasonCapacityUnknown',
    endpoint_capability_incomplete: 'set.ctxBudgetV1ReasonCapacityUnknown',
    context_policy_unreadable: 'set.ctxBudgetV1ReasonPolicyUnknown',
    context_policy_invalid: 'set.ctxBudgetV1ReasonPolicyUnknown'
  }
  const updateBudgetV1 = async (update: {
    mode: 'auto' | 'fixed'
    selectedBudget?: ContextBudgetTierV1
    autoMaxBudget?: ContextBudgetTierV1
  }): Promise<void> => {
    if (!budgetV1 || !activeBudgetPhase || budgetV1Busy) return
    setBudgetV1Busy(true)
    setBudgetV1Error('')
    try {
      const result = await window.yan.setContextBudgetV1({
        ...update,
        expectedRevision: budgetV1.revision
      })
      if (result.ok && result.policy) {
        setBudgetV1(result.policy)
        setBudgetV1Enabled(true)
      }
      else setBudgetV1Error(result.error ?? tk('set.ctxBudgetV1SaveFailed'))
    } catch {
      setBudgetV1Error(tk('set.ctxBudgetV1SaveFailed'))
    } finally {
      setBudgetV1Busy(false)
    }
  }
  /** 「到期自动回落」的显示时间（本地时区） */
  const fmtUntil = (at: number | null | undefined): string =>
    typeof at === 'number' && Number.isFinite(at)
      ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : ''

  /**
   * 整理失败后的一键出口：临时抬软线 / 降档。
   *
   * 为什么要同时“作废那笔整理”：失败后新消息会被拦下（不再每轮空跑 abort），
   * 而拦下它靠的就是那笔停在 `needs_action` 的记录。只改档位不处理它，
   * 用户点完还是发不出消息 —— 所以两个动作在主进程里一起做。
   */
  const exitMaintenanceBlock = async (action: 'raise-line' | 'lower-tier'): Promise<void> => {
    if (!budgetV1 || budgetV1Busy) return
    setBudgetV1Busy(true)
    setBudgetV1Error('')
    setMaintenanceMessage('')
    try {
      const result = await window.yan.contextBudgetMaintenanceExitV1({
        action,
        expectedRevision: budgetV1.revision
      })
      if (result.ok && result.policy) {
        setBudgetV1(result.policy)
        const selected = `${(result.selectedBudget ?? 0) / 1000}K`
        setMaintenanceMessage(result.temporary
          ? t('set.ctxBudgetV1RaiseApplied', { selected, until: fmtUntil(result.expiresAt) })
          : t('set.ctxBudgetV1ExitApplied', { selected }))
      } else setBudgetV1Error(result.error ?? tk('set.ctxBudgetV1SaveFailed'))
      setMaintenanceOperation(await window.yan.contextBudgetMaintenanceStatusV1())
    } catch {
      setBudgetV1Error(tk('set.ctxBudgetV1SaveFailed'))
    } finally {
      setBudgetV1Busy(false)
      void window.yan.contextBudgetSnapshotV1().then(setBudgetSnapshot).catch(() => undefined)
    }
  }

  const setMaterialPinned = async (materialId: string, pinned: boolean): Promise<void> => {
    if (!budgetV1 || budgetV1Busy) return
    setBudgetV1Busy(true)
    setBudgetV1Error('')
    try {
      const result = await window.yan.setContextBudgetMaterialPinV1({
        expectedRevision: budgetV1.revision,
        materialId,
        pinned
      })
      if (result.ok && result.policy) setBudgetV1(result.policy)
      else setBudgetV1Error(result.error ?? tk('set.ctxBudgetV1SaveFailed'))
    } catch {
      setBudgetV1Error(tk('set.ctxBudgetV1SaveFailed'))
    } finally {
      setBudgetV1Busy(false)
    }
  }

  const maintainContextV1 = async (operationId?: string): Promise<void> => {
    if (maintenanceBusy || !budgetV1Enabled) return
    setMaintenanceBusy(true)
    setMaintenanceMessage('')
    try {
      const result = await window.yan.contextBudgetMaintainV1(operationId)
      if (result.ok) {
        setMaintenanceMessage(tk(result.state === 'applied'
          ? 'set.ctxBudgetV1MaintenanceApplied'
          : 'set.ctxBudgetV1MaintenanceCommitted'))
      } else {
        setMaintenanceMessage(t('set.ctxBudgetV1MaintenanceFailed', { error: result.error ?? 'unknown' }))
      }
      setMaintenanceOperation(await window.yan.contextBudgetMaintenanceStatusV1())
    } catch (error) {
      setMaintenanceMessage(t('set.ctxBudgetV1MaintenanceFailed', {
        error: error instanceof Error ? error.message : 'unknown'
      }))
    } finally {
      setMaintenanceBusy(false)
      void window.yan.contextBudgetV1().then((value) => { if (value) setBudgetV1(value) }).catch(() => undefined)
      void window.yan.contextBudgetSnapshotV1().then(setBudgetSnapshot).catch(() => undefined)
      void window.yan.contextBudgetMaintenanceStatusV1().then(setMaintenanceOperation).catch(() => undefined)
    }
  }

  const otherKeys = Object.keys(byModel).filter((k) => k !== modelKey)
  const currentPreset = presetOf(user)
  /* Deep Context 不是「阈值」而是「多做一次模型调用」，所以不用草稿 + 保存那套 ——
     它就是一个开关，点一下写一次盘（与左栏置顶、声音提示同一种交互）。 */
  const deepOn = settings?.contextDeep?.enabled === true
  /*
   * 任务状态记忆（`episode-fold`）同样是个开关，但**默认方向相反**：它在默认接管集里，
   * 所以 `undefined`（用户没改过）算开，只有存到 `{enabled:false}` 才算关。
   * 界面因此不能直接读 `enabled`，得读「是不是被明确关掉了」。
   */
  const foldOff = settings?.contextFold?.enabled === false

  return (
    <div className="ui-rows">
      <div className="ui-row col" data-testid="ctx-budget-v1">
        <div className="ui-row-label">
          <div className="ui-row-name">{tk('set.ctxBudgetV1Title')}</div>
          <div className="ui-row-desc">{tk('set.ctxBudgetV1Desc')}</div>
        </div>
        {activeBudgetPhase ? (
          <>
            {!budgetV1Enabled ? (
              <div className="ui-row-desc" data-testid="ctx-budget-v1-legacy" role="status">
                {tk('set.ctxBudgetV1Legacy')}
              </div>
            ) : null}
            {budgetV1Enabled ? (
              <div className="ui-row-desc set-num" data-testid="ctx-budget-v1-current">
                {t('set.ctxBudgetV1Current', {
                  mode: tk(activeBudgetPhase.mode === 'auto' ? 'set.ctxBudgetV1Auto' : 'set.ctxBudgetV1Fixed'),
                  selected: `${activeBudgetPhase.selectedBudget / 1000}K`,
                  phase: activeBudgetPhase.phaseId
                })}
              </div>
            ) : null}
            <div className="ui-row-ctl seg seg-scale" aria-label={tk('set.ctxBudgetV1Mode')}>
              <button
                className={`seg-btn ${budgetV1Enabled && activeBudgetPhase.mode === 'auto' ? 'sel' : ''}`}
                data-testid="ctx-budget-v1-auto"
                disabled={budgetV1Busy}
                onClick={() => void updateBudgetV1({ mode: 'auto', autoMaxBudget: activeBudgetPhase.autoMaxBudget })}
              >
                {tk('set.ctxBudgetV1Auto')}
              </button>
              {CONTEXT_BUDGET_V1_TIERS.map((tier) => (
                <button
                  key={tier}
                  className={`seg-btn ${budgetV1Enabled && activeBudgetPhase.mode === 'fixed' && activeBudgetPhase.selectedBudget === tier ? 'sel' : ''}`}
                  data-testid={`ctx-budget-v1-fixed-${tier}`}
                  disabled={budgetV1Busy}
                  onClick={() => void updateBudgetV1({ mode: 'fixed', selectedBudget: tier })}
                >
                  {tk('set.ctxBudgetV1Fix')} {tier / 1000}K
                </button>
              ))}
            </div>
            {budgetV1Enabled && activeBudgetPhase.mode === 'auto' ? (
              <div className="ui-row-ctl seg seg-scale" aria-label={tk('set.ctxBudgetV1AutoMax')}>
                {CONTEXT_BUDGET_V1_TIERS.map((tier) => (
                  <button
                    key={tier}
                    className={`seg-btn ${activeBudgetPhase.autoMaxBudget === tier ? 'sel' : ''}`}
                    data-testid={`ctx-budget-v1-max-${tier}`}
                    disabled={budgetV1Busy}
                    onClick={() => void updateBudgetV1({ mode: 'auto', autoMaxBudget: tier })}
                  >
                    {tk('set.ctxBudgetV1Max')} {tier / 1000}K
                  </button>
                ))}
              </div>
            ) : null}
            {budgetSnapshot ? (
              <div className="ui-row-desc set-num" data-testid="ctx-budget-v1-last-check" role="status">
                {t('set.ctxBudgetV1LastCheck', {
                  time: new Date(budgetSnapshot.observedAt).toLocaleTimeString(),
                  decision: tk(budgetDecisionKey),
                  input: budgetSnapshot.inputTokens?.toLocaleString('en-US') ?? tk('set.ctxBudgetV1Unknown'),
                  selected: `${budgetSnapshot.check.selectedBudget / 1000}K`,
                  review: budgetSnapshot.check.calculation.reviewLine?.toLocaleString('en-US') ?? tk('set.ctxBudgetV1Unknown'),
                  hard: budgetSnapshot.check.calculation.hardInputLimit?.toLocaleString('en-US') ?? tk('set.ctxBudgetV1Unknown')
                })}
                <br />
                {tk(budgetReasonKeys[budgetSnapshot.check.reason] ?? 'set.ctxBudgetV1ReasonGeneric')}
                <br />
                <button
                  className="seg-btn"
                  data-testid="ctx-budget-v1-refresh-snapshot"
                  disabled={budgetV1Busy}
                  onClick={() => {
                    void window.yan.contextBudgetSnapshotV1().then(setBudgetSnapshot).catch(() => {
                      setBudgetV1Error(tk('set.ctxBudgetV1Unavailable'))
                    })
                  }}
                >
                  {tk('set.ctxBudgetV1Refresh')}
                </button>
              </div>
            ) : null}
            <div className="ui-row-desc" data-testid="ctx-budget-v1-maintenance">
              <div>{tk('set.ctxBudgetV1MaintenanceHelp')}</div>
              {maintenanceOperation ? (
                <div data-testid="ctx-budget-v1-maintenance-status" role="status">
                  {tk(`set.ctxBudgetV1MaintenanceState.${maintenanceOperation.state}`)}
                  {maintenanceOperation.failureCode === 'resume_send_uncertain'
                    ? ` · ${tk('set.ctxBudgetV1MaintenanceResumeUncertain')}`
                    : maintenanceOperation.failureCode
                      ? ` · ${maintenanceFailureText(maintenanceOperation.failureCode, tk)}`
                      : ''}
                  {/* 卡在哪一步 + 能否直接重试：失败时用户要知道「等一下再试」还是「先去处理原因」 */}
                  {maintenanceOperation.failureCode && maintenanceOperation.failedStage ? (
                    <div data-testid="ctx-budget-v1-maintenance-stage">
                      {t('set.ctxBudgetV1MaintenanceStoppedAt', {
                        stage: maintenanceOperation.failedStage === 'resuming'
                          ? tk('set.ctxBudgetV1MaintenanceStageResuming')
                          : tk(`set.ctxBudgetV1MaintenanceState.${maintenanceOperation.failedStage}`)
                      })}
                      {typeof maintenanceOperation.retryable === 'boolean'
                        ? ` · ${tk(maintenanceOperation.retryable ? 'set.ctxBudgetV1MaintenanceRetryable' : 'set.ctxBudgetV1MaintenanceNotRetryable')}`
                        : ''}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <button
                className="seg-btn"
                data-testid="ctx-budget-v1-maintain"
                disabled={!budgetV1Enabled || budgetV1Busy || maintenanceBusy}
                onClick={() => void maintainContextV1()}
              >
                {tk(maintenanceBusy ? 'set.ctxBudgetV1Maintaining' : 'set.ctxBudgetV1Maintain')}
              </button>
              {maintenanceOperation && (maintenanceOperation.state === 'needs_action' || maintenanceOperation.state === 'failed') &&
                maintenanceOperation.failureCode !== 'resume_send_uncertain' ? (
                <button
                  className="seg-btn"
                  data-testid="ctx-budget-v1-maintenance-retry"
                  disabled={!budgetV1Enabled || budgetV1Busy || maintenanceBusy}
                  onClick={() => void maintainContextV1(maintenanceOperation.identity.operationId)}
                >
                  {tk('set.ctxBudgetV1MaintenanceRetry')}
                </button>
              ) : null}
              {/*
                失败停下后，”重试“并不总是最优解：没有候选、归档满这类确定性失败，
                重试只会得到同样结果。另两个出口直接改变处境：抬线让它不再撞线，
                降档让这一轮本来就发得出去。
              */}
              {maintenanceOperation && (maintenanceOperation.state === 'needs_action' || maintenanceOperation.state === 'failed') ? (
                <>
                  <button
                    className="seg-btn"
                    data-testid="ctx-budget-v1-exit-raise"
                    disabled={!budgetV1Enabled || budgetV1Busy || maintenanceBusy}
                    onClick={() => void exitMaintenanceBlock('raise-line')}
                  >
                    {tk('set.ctxBudgetV1ExitRaise')}
                  </button>
                  <button
                    className="seg-btn"
                    data-testid="ctx-budget-v1-exit-lower"
                    disabled={!budgetV1Enabled || budgetV1Busy || maintenanceBusy}
                    onClick={() => void exitMaintenanceBlock('lower-tier')}
                  >
                    {tk('set.ctxBudgetV1ExitLower')}
                  </button>
                </>
              ) : null}
              {activeTemporaryOverride ? (
                <div className="ui-row-desc" data-testid="ctx-budget-v1-temporary-raise" role="status">
                  {t('set.ctxBudgetV1TemporaryRaise', {
                    selected: `${activeTemporaryOverride.selectedBudget / 1000}K`,
                    falls: `${activeBudgetPhase.selectedBudget / 1000}K`,
                    until: fmtUntil(activeTemporaryOverride.expiresAt)
                  })}
                </div>
              ) : null}
              {maintenanceOperation?.state === 'needs_action' ? (
                <div className="ui-row-desc" data-testid="ctx-budget-v1-blocked" role="status">
                  {tk('set.ctxBudgetV1BlockedHint')}
                </div>
              ) : null}
              {maintenanceMessage ? <div role="status">{maintenanceMessage}</div> : null}
            </div>
            {activeBudgetPhase.materials.length > 0 ? (
              <div className="ui-row-desc" data-testid="ctx-budget-v1-materials">
                <div>{t('set.ctxBudgetV1Materials', { count: activeBudgetPhase.materials.length })}</div>
                {[...activeBudgetPhase.materials.filter((material) => material.pinnedByUser),
                  ...activeBudgetPhase.materials.filter((material) => !material.pinnedByUser).slice(-20)]
                  .map((material) => (
                    <div key={material.id} className="set-ctrow" data-testid={`ctx-budget-v1-material-${material.id}`}>
                      <span title={material.purpose}>
                        {material.sourceRef} · ~{material.tokenEstimate.toLocaleString('en-US')} tokens
                        {material.status !== 'available' ? ` · ${material.status}` : ''}
                      </span>
                      <button
                        className="seg-btn"
                        data-testid={`ctx-budget-v1-pin-${material.id}`}
                        disabled={budgetV1Busy}
                        onClick={() => void setMaterialPinned(material.id, !material.pinnedByUser)}
                      >
                        {tk(material.pinnedByUser ? 'set.ctxBudgetV1Unpin' : 'set.ctxBudgetV1Pin')}
                      </button>
                    </div>
                  ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="ui-row-desc" role="status">{budgetV1Error || tk('set.ctxBudgetV1Unavailable')}</div>
        )}
        {budgetV1Error && activeBudgetPhase ? <div className="ui-row-desc" role="alert">{budgetV1Error}</div> : null}
      </div>
      {/*
       * 任务状态记忆（`episode-fold`，P2-7）。与 Deep Context 相邻是因为它们是同一类东西 ——
       * 都会**多花一次模型调用**；差别是它默认开，而且只在会话够长、并且这一回合
       * 真的改过东西（脏判定）时才动手，短会话与纯只读回合不花钱。
       * 它进默认接管集后一直没有界面入口（想关只能手改 `kinds`），这一行补的就是这个缺口。
       */}
      <div className="ui-row col">
        <div className="set-ctrow">
          <div className="ui-row-label">
            <span>{tk('set.foldTitle')}</span>
            <span className="set-tag">{tk('set.foldTag')}</span>
          </div>
          <div className="ui-row-ctl seg" data-testid="ctx-fold">
            <button
              className="seg-btn"
              data-testid="ctx-fold-toggle"
              onClick={() => void patchSettings({ contextFold: { enabled: foldOff } })}
            >
              {tk(foldOff ? 'set.foldOff' : 'set.foldOn')}
            </button>
          </div>
        </div>
        <div className="ui-row-desc" data-testid="ctx-fold-desc">
          {tk(foldOff ? 'set.foldDescOff' : 'set.foldDescOn')}
        </div>
      </div>
      {/*
       * Deep Context（N21-8）。它与本页其它选项**不是一类**：那些改的是「什么时候压缩」，
       * 而它改的是「回答前要不要先归纳一遍工作集」—— 代价是**同步阻塞**一次模型调用
       * （每轮最多多等 30s），所以默认关、说清楚再让人自己选。
       */}
      <div className="ui-row col">
        <div className="set-ctrow">
          <div className="ui-row-label">
            <span>{tk('set.deepTitle')}</span>
            <span className="set-tag">{tk('set.deepTag')}</span>
          </div>
          <div className="ui-row-ctl seg" data-testid="ctx-deep">
            <button
              className="seg-btn"
              data-testid="ctx-deep-toggle"
              onClick={() => void patchSettings({ contextDeep: { enabled: !deepOn } })}
            >
              {tk(deepOn ? 'set.deepOn' : 'set.deepOff')}
            </button>
          </div>
        </div>
        <div className="ui-row-desc" data-testid="ctx-deep-desc">
          {tk(deepOn ? 'set.deepDescOn' : 'set.deepDescOff')}
        </div>
      </div>
      {/* 生效来源：这一块的全部意义就是“让人相信界面上的数就是真正在用的数” */}
      <div className="ui-row col">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('set.ctxSource')}</div>
          <div className="ui-row-desc" data-testid="ctx-source">
            {policy
              ? `${tk(`set.ctxSource.${policy.source}`)}${
                  policy.sourceKey ? ` · ${policy.sourceKey}` : ''
                } · ${t('set.ctxWorkingSet', { n: policy.budget.workingSet.toLocaleString('en-US') })}`
              : t('set.ctxSource.off')}
          </div>
          <div className="ui-row-desc set-num">
            {policy?.overridden?.length
              ? t('set.ctxOverridden', { fields: policy.overridden.map((f) => tk(`set.ctxField.${f}`)).join(' / ') })
              : t('set.ctxAllDefault')}
          </div>
        </div>
      </div>

      <SettingRow name={t('set.ctxPreset')} desc={t('set.ctxPresetDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': "ctx-preset" }}>
          {(['default', 'reference'] as const).map((p) => (
            <button
              key={p}
              className={`seg-btn ${currentPreset === p ? 'sel' : ''}`}
              data-preset={p}
              onClick={() => void patchSettings({ contextPolicy: presetOverrides(p) })}
            >
              {tk(`set.ctxPreset.${p}`)}
            </button>
          ))}
        </SettingRow>

      <NumRow
        label={t('set.ctxCap')}
        desc={t('set.ctxCapDesc')}
        testid="ctx-cap"
        value={draft.cap}
        onChange={(v) => setDraft({ ...draft, cap: v })}
      />
      <NumRow
        label={t('set.ctxRatio')}
        desc={t('set.ctxRatioDesc')}
        testid="ctx-ratio"
        value={draft.ratio}
        onChange={(v) => setDraft({ ...draft, ratio: v })}
      />
      <NumRow
        label={t('set.ctxReserve')}
        desc={t('set.ctxReserveDesc')}
        testid="ctx-reserve"
        value={draft.reserve}
        onChange={(v) => setDraft({ ...draft, reserve: v })}
      />

      <SettingRow desc={t('set.ctxHint')} ctlClassName="seg">
          <button className="seg-btn" data-testid="ctx-save" onClick={saveUser}>
            {t('set.ctxSave')}
          </button>
          <button
            className="seg-btn"
            data-testid="ctx-reset"
            onClick={() => {
              setDraft(fields(undefined))
              void patchSettings({ contextPolicy: undefined })
            }}
          >
            {t('set.ctxReset')}
          </button>
        </SettingRow>

      {/* ---- 模型级覆盖 ---- */}
      <SettingRow col name={t('set.ctxModel')} desc={modelKey ? t('set.ctxModelDesc', { model: modelKey }) : t('set.ctxModelNoModel')} />

      {modelKey ? (
        <>
          <SettingRow col data-testid="ctx-model-presets" name={tk('set.ctxModelPreset')} desc={tk(largeWindowCandidate ? 'set.ctxModelPresetDesc' : 'set.ctxModelPresetUnavailable')} ctlClassName="seg">
              <button
                className={`seg-btn ${modelLargePreset === 'balanced' ? 'sel' : ''}`}
                data-testid="ctx-model-large-balanced"
                disabled={!largeWindowCandidate}
                onClick={() => applyModelLargePreset('balanced')}
              >
                {tk('set.ctxModelPresetBalanced')}
              </button>
              <button
                className={`seg-btn ${modelLargePreset === 'long' ? 'sel' : ''}`}
                data-testid="ctx-model-large-long"
                disabled={!largeWindowCandidate}
                onClick={() => applyModelLargePreset('long')}
              >
                {tk('set.ctxModelPresetLong')}
              </button>
            </SettingRow>
          <NumRow
            label={t('set.ctxCap')}
            desc={t('set.ctxCapDesc')}
            testid="ctx-model-cap"
            value={modelDraft.cap}
            onChange={(v) => setModelDraft({ ...modelDraft, cap: v })}
          />
          <NumRow
            label={t('set.ctxRatio')}
            desc={t('set.ctxRatioDesc')}
            testid="ctx-model-ratio"
            value={modelDraft.ratio}
            onChange={(v) => setModelDraft({ ...modelDraft, ratio: v })}
          />
          <SettingRow desc={t('set.ctxModelHint')} ctlClassName="seg">
              <button className="seg-btn" data-testid="ctx-model-save" onClick={saveModel}>
                {modelOver ? t('set.ctxModelUpdate') : t('set.ctxModelAdd')}
              </button>
              {modelOver ? (
                <button
                  className="seg-btn"
                  data-testid="ctx-model-remove"
                  onClick={() => {
                    setModelDraft(fields(undefined))
                    removeModel(modelKey)
                  }}
                >
                  {t('set.ctxModelRemove')}
                </button>
              ) : null}
            </SettingRow>
        </>
      ) : null}

      {otherKeys.length ? (
        <div className="ui-row col">
          <div className="ui-row-label">
            <div className="ui-row-name">{t('set.ctxModelOthers')}</div>
            {otherKeys.map((k) => (
              <div
                className="ui-row-desc set-num"
                key={k}
                data-testid="ctx-model-other"
                /* 长 `provider/model` 在窄栏会被截断：完整值用 title 给出口 */
                title={`${k} · ${summary(byModel[k])}`}
              >
                {k} · {summary(byModel[k])}
                <button className="ctx-link" onClick={() => removeModel(k)}>
                  {t('set.ctxModelRemove')}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/*
        后台调用用量（供应商口径）。
        为什么单独一栏：这些请求绕开会话循环（或跑在独立进程里），
        主对话的用量条永远看不到它们 —— 用户只能看到一个“总量”，
        没法回答“是主对话花得多，还是后台在烧”。
      */}
      {backgroundUsage ? (
        <div className="ui-row col" data-testid="ctx-background-usage">
          <div className="ui-row-label">
            <div className="ui-row-name">{t('set.ctxBackgroundUsage')}</div>
            <div className="ui-row-desc">{t('set.ctxBackgroundUsageDesc')}</div>
          </div>
          {backgroundUsage.calls === 0 ? (
            <div className="ui-row-desc" role="status">{t('set.ctxBackgroundUsageEmpty')}</div>
          ) : (
            <>
              <div className="ui-row-desc set-num" data-testid="ctx-background-usage-total" role="status">
                {t('set.ctxBackgroundUsageTotal', {
                  calls: String(backgroundUsage.calls),
                  input: fmtTok(backgroundUsage.input),
                  hit: backgroundUsage.cacheHitRate === null ? '—' : `${backgroundUsage.cacheHitRate.toFixed(1)}%`,
                  output: fmtTok(backgroundUsage.output)
                })}
              </div>
              {backgroundUsage.kinds.filter((kind) => kind.calls > 0).map((kind) => (
                <div
                  className="ui-row-desc set-num"
                  key={kind.kind}
                  data-testid={`ctx-background-usage-${kind.kind}`}
                >
                  {t('set.ctxBackgroundUsageKind', {
                    kind: tk(`set.ctxBackgroundKind.${kind.kind}`),
                    calls: String(kind.calls),
                    input: fmtTok(kind.input),
                    hit: kind.input + kind.cacheRead > 0
                      ? `${((kind.cacheRead / (kind.input + kind.cacheRead)) * 100).toFixed(1)}%`
                      : '—'
                  })}
                </div>
              ))}
              {backgroundUsage.missingUsage > 0 ? (
                <div className="ui-row-desc" role="status">
                  {t('set.ctxBackgroundUsageMissing', { count: String(backgroundUsage.missingUsage) })}
                </div>
              ) : null}
            </>
          )}
          <div className="ui-row-ctl">
            <button className="seg-btn" data-testid="ctx-background-usage-refresh" onClick={() => void refreshBackgroundUsage()}>
              {t('set.ctxBackgroundUsageRefresh')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ 小组件 */

/** token 数缩写（与对话用量条同一口径，界面上的数字要能互相核对） */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString('en-US')
}

/** 数值输入行（留空 = 用默认值） */
/** 有人话说明的整理失败码（与 i18n 的 set.ctxBudgetV1Failure.* 一一对应）；其余显示原码 */
const EXPLAINED_MAINTENANCE_FAILURES = new Set([
  'context_source_revision_changed',
  'context_policy_revision_changed',
  'context_capability_revision_changed',
  'context_versions_changed_before_commit',
  'context_branch_unavailable',
  'summary_generation_failed',
  'summary_did_not_reduce_context',
  'no_safe_summary_candidates',
  'active_projection_unavailable',
  'active_projection_source_missing',
  'context_recall_archive_full',
  'context_recall_source_missing',
  'context_recall_ref_conflict',
  'context_recall_archive_invalid',
  'runner_restarted_before_commit',
  'automatic_maintenance_failed'
])

function maintenanceFailureText(code: string, tk: (key: string) => string): string {
  return EXPLAINED_MAINTENANCE_FAILURES.has(code) ? `${tk(`set.ctxBudgetV1Failure.${code}`)}（${code}）` : code
}

function NumRow({
  label,
  desc,
  value,
  onChange,
  testid
}: {
  label: string
  desc: string
  value: string
  onChange: (v: string) => void
  testid: string
}) {
  return (
    <SettingRow name={label} desc={desc}>
        <input
          className="ui-input num"
          type="number"
          inputMode="numeric"
          data-testid={testid}
          value={value}
          placeholder="—"
          onChange={(e) => onChange(e.target.value)}
        />
      </SettingRow>
  )
}

/* ------------------------------------------------------------------ 纯逻辑 */

interface Fields {
  cap: string
  ratio: string
  reserve: string
}

function fields(o: ContextPolicyOverrides | undefined): Fields {
  return {
    cap: o?.workingSetCap === undefined ? '' : String(o.workingSetCap),
    ratio: o?.windowRatio === undefined ? '' : String(o.windowRatio),
    reserve: o?.responseReservePreferred === undefined ? '' : String(o.responseReservePreferred)
  }
}

/** 草稿 → 覆盖对象；三个字段都空时返回 undefined（= 没有覆盖） */
function overridesFrom(d: Fields): ContextPolicyOverrides | undefined {
  const out: ContextPolicyOverrides = {}
  const num = (v: string): number | undefined => {
    const s = v.trim()
    if (!s) return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  const cap = num(d.cap)
  if (cap !== undefined) out.workingSetCap = cap
  const ratio = num(d.ratio)
  if (ratio !== undefined) out.windowRatio = ratio
  const reserve = num(d.reserve)
  if (reserve !== undefined) out.responseReservePreferred = reserve
  return Object.keys(out).length ? out : undefined
}

function presetOverrides(p: 'default' | 'reference'): ContextPolicyOverrides | undefined {
  const o = CONTEXT_POLICY_PRESETS[p]
  return Object.keys(o).length ? { ...o } : undefined
}

/** 当前用户级覆盖命中了哪个预设（都不命中时 undefined —— 界面就不亮任何一项） */
function presetOf(o: ContextPolicyOverrides): 'default' | 'reference' | undefined {
  if (!Object.keys(o).length) return 'default'
  const ref = CONTEXT_POLICY_PRESETS.reference
  const keys = Object.keys(o)
  const sameRef =
    keys.length === 2 &&
    o.workingSetCap === ref.workingSetCap &&
    o.windowRatio === ref.windowRatio
  return sameRef ? 'reference' : undefined
}

function summary(o: ContextPolicyOverrides): string {
  const parts: string[] = []
  if (o.workingSetCap !== undefined) parts.push(`cap ${o.workingSetCap}`)
  if (o.windowRatio !== undefined) parts.push(`ratio ${o.windowRatio}`)
  if (o.responseReservePreferred !== undefined) parts.push(`reserve ${o.responseReservePreferred}`)
  return parts.join(' · ') || '—'
}
