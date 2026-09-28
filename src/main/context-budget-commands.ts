/**
 * `yan context budget status|adjust` 与回合边界上的上下文预算记账。
 *
 * 模型只给来源引用与用途，不给可信的 token 数、也不写策略文件：预算估算、候选材料扫描、
 * 阶段边界记录与按实际输入回收档位都在这里，由宿主校验后落盘（context-budget-store）。
 * 控制器的当前状态、消息与 cwd 经 `ContextBudgetHost` 读取。
 */
import type { SessionState, UIMessage } from '../shared/ipc'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CapabilityCommandResult } from './capability-server'
import { CapabilityCommandError } from './capability-server'
import { YAN_DIR } from './paths'
import { contextStatePath, isSafeSessionId } from './context-state-store'
import { inspectContextStateFile } from '../shared/context-state'
import { readSessionEntryIndex } from './context-watermark'
import { contextBudgetStoreV1, ContextBudgetStoreError } from './context-budget-store'
import { calculateContextBudgetV1, effectiveContextBudgetTierV1, estimateTextTokensV1, selectAutoContextBudgetV1, reconcileObservedContextBudgetV1 } from '../shared/context-budget-v1'
import type { ContextBudgetMaterialRecordV1, ContextBudgetSessionPolicyV1, EndpointBudgetCapabilityV1 } from '../shared/context-budget-v1'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function distinctTextTokens(values: string[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const value of values) {
    const text = value.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    total += estimateTextTokensV1(text)
  }
  return total
}

function activeTaskStateTexts(raw: unknown): string[] {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.task)) return []
  const texts: string[] = []
  const objective = raw.task.objective
  const phase = raw.task.currentPhase
  if (typeof objective === 'string') texts.push(objective)
  if (typeof phase === 'string') texts.push(phase)
  for (const key of [
    'currentState', 'decisions', 'constraints', 'completed', 'failedAttempts',
    'unresolved', 'nextActions', 'assumptions', 'hypothesis'
  ]) {
    const entries = raw.task[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (isPlainRecord(entry) && entry.status === 'active' && typeof entry.text === 'string') texts.push(entry.text)
    }
  }
  for (const key of ['files', 'commandsRun', 'testsRun', 'symbolsTouched']) {
    const entries = raw.task[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isPlainRecord(entry)) continue
      for (const field of ['path', 'state', 'command', 'summary', 'name', 'symbol']) {
        const value = entry[field]
        if (typeof value === 'string') texts.push(value)
      }
    }
  }
  return texts
}

export interface ContextBudgetHost {
  state(): SessionState | null
  messages(): UIMessage[]
  cwd(): string
}

export class ContextBudgetCommands {
  constructor(private readonly host: ContextBudgetHost) {}

  /**
   * `yan context budget status|adjust` is the agent's structured, host-validated
   * path for preparing the next request budget. The model supplies source refs
   * and purpose; it never supplies a trusted token count or writes policy files.
   */
  async runContextBudgetCommand(
    command: string,
    params: Record<string, unknown>
  ): Promise<CapabilityCommandResult> {
    const sessionId = this.host.state()?.sessionId
    if (!isSafeSessionId(sessionId)) {
      throw new CapabilityCommandError('context_session_unavailable', '当前还没有可安全调整预算的会话')
    }
    if (command === 'context.budget.status') {
      try {
        const policy = await contextBudgetStoreV1.read(sessionId)
        const phase = policy.phases[policy.activePhaseId]
        const active = await contextBudgetStoreV1.isConfigured(sessionId)
        return {
          data: { policy, activePhase: phase, active, strategy: active ? 'budget-v1' : 'legacy' },
          summary: {
            kind: 'context-budget',
            action: 'status',
            mode: active ? (phase?.mode ?? 'auto') : 'legacy',
            selectedBudget: phase?.selectedBudget ?? 200_000,
            /* 真正生效的软线（临时抬线仍然算数）—— 只看 selectedBudget 会漏掉抬上去的那部分 */
            effectiveBudget: phase
              ? effectiveContextBudgetTierV1({
                  selectedBudget: phase.selectedBudget,
                  temporaryBudgetOverride: phase.temporaryBudgetOverride
                })
              : 200_000,
            autoMaxBudget: phase?.autoMaxBudget ?? 700_000,
            phaseId: policy.activePhaseId,
            registeredMaterials: phase?.materials.filter((material) => material.status === 'available').length ?? 0
          }
        }
      } catch (error) {
        if (error instanceof ContextBudgetStoreError) {
          throw new CapabilityCommandError(`context_budget_${error.code}`, error.message)
        }
        throw new CapabilityCommandError('context_budget_unavailable', '上下文预算状态暂时不可用；现有文件已保留')
      }
    }
    if (command !== 'context.budget.adjust') {
      throw new CapabilityCommandError('context_budget_action_unknown', '只支持 context budget status 或 adjust')
    }

    const expectedRevision = typeof params.expectedPolicyRevision === 'string'
      ? params.expectedPolicyRevision
      : ''
    const purpose = typeof params.purpose === 'string' ? params.purpose.trim() : ''
    const reason = typeof params.reason === 'string' ? params.reason.trim() : ''
    if (!expectedRevision || !purpose || !reason) {
      throw new CapabilityCommandError(
        'context_budget_adjust_missing_fields',
        'adjust 需要 expectedPolicyRevision、purpose 和 reason'
      )
    }
    if (purpose.length > 1000 || reason.length > 2000) {
      throw new CapabilityCommandError('context_budget_adjust_text_too_long', 'purpose 或 reason 超过允许长度')
    }
    const requestedRefs = params.requiredMaterialRefs === undefined ? [] : params.requiredMaterialRefs
    const releaseIds = params.releaseMaterialIds === undefined ? [] : params.releaseMaterialIds
    if (params.startNewPhase !== undefined && typeof params.startNewPhase !== 'boolean') {
      throw new CapabilityCommandError('context_budget_phase_invalid', 'startNewPhase 只能是布尔值')
    }
    if (!Array.isArray(requestedRefs) || requestedRefs.length > 50 || !Array.isArray(releaseIds) || releaseIds.length > 100) {
      throw new CapabilityCommandError('context_budget_material_list_invalid', '材料列表形状无效或数量超过上限')
    }

    let policy
    try {
      policy = await contextBudgetStoreV1.read(sessionId)
    } catch (error) {
      const message = error instanceof ContextBudgetStoreError ? error.message : '上下文预算状态暂时不可用'
      throw new CapabilityCommandError('context_budget_store_unavailable', message)
    }
    if (!(await contextBudgetStoreV1.isConfigured(sessionId))) {
      throw new CapabilityCommandError(
        'context_budget_legacy_session',
        '当前旧会话仍使用原上下文策略；先在上下文设置中启用 V1 自动模式，再由 agent 自主调档'
      )
    }
    if (policy.revision !== expectedRevision) {
      throw new CapabilityCommandError('context_budget_stale_revision', '策略版本已变化；先运行 yan context budget status')
    }
    const startNewPhase = params.startNewPhase === true
    const previousPhaseId = policy.activePhaseId
    const previousPhase = policy.phases[previousPhaseId]
    if (!previousPhase) throw new CapabilityCommandError('context_budget_phase_missing', '当前任务阶段状态缺失')
    if (startNewPhase && Object.keys(policy.phases).length >= 100) {
      throw new CapabilityCommandError('context_budget_phase_limit', '本会话任务阶段达到 100 段上限；先结束或整理旧任务阶段')
    }
    const phaseId = startNewPhase
      ? `phase-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
      : previousPhaseId
    const carriedPinnedMaterials = startNewPhase
      ? [...new Map(
          Object.values(policy.phases)
            .flatMap((item) => item.materials)
            .filter((material) => material.pinnedByUser)
            .map((material) => [
              `${material.sourceRef}\0${material.range?.start ?? '*'}:${material.range?.end ?? '*'}:${material.contentHash}`,
              { ...material, phaseId }
            ])
        ).values()]
      : previousPhase.materials
    if (carriedPinnedMaterials.length > 500) {
      throw new CapabilityCommandError('context_budget_pinned_materials_limit', '用户固定材料超过新阶段可继承上限；请先整理固定材料')
    }
    const phase = startNewPhase
      ? {
          ...previousPhase,
          phaseId,
          materials: carriedPinnedMaterials,
          materialRevision: randomUUID(),
          consecutiveLowBoundaries: 0,
          lastBoundaryRevision: undefined
        }
      : previousPhase

    const releaseSet = new Set<string>()
    for (const raw of releaseIds) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(raw)) {
        throw new CapabilityCommandError('context_budget_release_invalid', 'releaseMaterialIds 含无效材料 ID')
      }
      const existing = previousPhase.materials.find((material) => material.id === raw)
      if (!existing) throw new CapabilityCommandError('context_budget_release_unknown', `材料不存在：${raw}`)
      if (existing.pinnedByUser) {
        throw new CapabilityCommandError('context_budget_release_pinned', `材料由用户固定，不能由 agent 释放：${raw}`)
      }
      releaseSet.add(raw)
    }

    const scanned: Array<{ material: ContextBudgetMaterialRecordV1; content: string }> = []
    let scannedBytes = 0
    if (startNewPhase) {
      for (const pinned of carriedPinnedMaterials) {
        if (pinned.status !== 'available') {
          throw new CapabilityCommandError('context_budget_pinned_material_stale', `固定材料不可用，不能隐式继承：${pinned.sourceRef}`)
        }
        const remainingBytes = 8 * 1024 * 1024 - scannedBytes
        const checked = await this.scanContextBudgetMaterial(sessionId, phaseId, {
          path: pinned.sourceRef,
          purpose: pinned.purpose,
          ...(pinned.range ? { range: { start: pinned.range.start, end: pinned.range.end } } : {})
        }, remainingBytes)
        if (checked.material.contentHash !== pinned.contentHash) {
          throw new CapabilityCommandError('context_budget_pinned_material_changed', `固定材料内容已变化；先解除固定，再登记并固定新版本：${pinned.sourceRef}`)
        }
        scannedBytes += checked.readBytes
        scanned.push({
          ...checked,
          material: {
            ...checked.material,
            pinnedByUser: true,
            requiredTogether: pinned.requiredTogether
          }
        })
      }
    }
    for (const item of requestedRefs) {
      if (!isPlainRecord(item) || typeof item.path !== 'string' || typeof item.purpose !== 'string') {
        throw new CapabilityCommandError('context_budget_material_invalid', '每项材料都需要 path 和 purpose')
      }
      const remainingBytes = 8 * 1024 * 1024 - scannedBytes
      const material = await this.scanContextBudgetMaterial(sessionId, phaseId, item, remainingBytes)
      scannedBytes += material.readBytes
      scanned.push(material)
    }

    const nextMaterials = phase.materials.filter((material) => !releaseSet.has(material.id))
    for (const entry of scanned) {
      const existingIndex = nextMaterials.findIndex((material) =>
        material.sourceRef === entry.material.sourceRef &&
        material.range?.start === entry.material.range?.start &&
        material.range?.end === entry.material.range?.end
      )
      if (existingIndex < 0) {
        nextMaterials.push(entry.material)
      } else {
        const existing = nextMaterials[existingIndex]
        nextMaterials[existingIndex] = {
          ...entry.material,
          pinnedByUser: existing.pinnedByUser || entry.material.pinnedByUser
        }
      }
    }
    if (nextMaterials.length > 500) {
      throw new CapabilityCommandError('context_budget_material_limit', '当前阶段材料达到 500 项上限；先释放不再需要的材料')
    }
    const materialsChanged = JSON.stringify(nextMaterials) !== JSON.stringify(phase.materials)

    const snapshot = await this.readPreparedBudgetSnapshot(sessionId)
    const model = this.host.state()?.model
    if (
      !snapshot ||
      !model?.provider || !model.id || !model.endpointKey ||
      snapshot.endpoint.provider !== model.provider ||
      snapshot.endpoint.modelId !== model.id ||
      snapshot.endpoint.endpointKey !== model.endpointKey
    ) {
      throw new CapabilityCommandError(
        'context_budget_baseline_unavailable',
        '没有与当前模型匹配的近期请求基线；暂不根据猜测调档'
      )
    }
    const endpointBudget = this.budgetCapabilityOf(snapshot, model)
    if (endpointBudget.outputReserve === null) {
      throw new CapabilityCommandError('context_budget_output_reserve_unavailable', '最终请求没有可核实的输出额度 R')
    }
    const { outputReserve, capability } = endpointBudget
    if (!capability) {
      throw new CapabilityCommandError('context_budget_capacity_unavailable', '当前模型没有可核实的窗口和输出能力')
    }

    let taskStateTexts: string[]
    try {
      taskStateTexts = await this.currentBudgetTaskStateTexts(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前任务状态不可核实'
      throw new CapabilityCommandError('context_budget_task_state_unavailable', message)
    }
    const userTokens = this.host.messages().reduce((sum, message) => {
      if (message.role !== 'user') return sum
      const images = message.images?.length ?? 0
      return sum + 4 + estimateTextTokensV1(message.text) + images * 1600
    }, 0)
    const fixedRequestTokens = snapshot.systemTokens + snapshot.toolsTokens
    const knownText = [purpose, reason, ...taskStateTexts]
    const alreadyPresent = (text: string): boolean =>
      this.host.messages().some((message) => message.text.includes(text))
    const countedMaterialHashes = new Set<string>()
    const registeredMaterialTokens = nextMaterials.reduce((sum, material) => {
      if (material.status !== 'available' || countedMaterialHashes.has(material.contentHash)) return sum
      countedMaterialHashes.add(material.contentHash)
      const contentIsAlreadyPresent = scanned.some((entry) =>
        entry.material.contentHash === material.contentHash && alreadyPresent(entry.content)
      )
      return contentIsAlreadyPresent ? sum : sum + material.tokenEstimate
    }, 0)
    const requiredInputTokens =
      fixedRequestTokens + userTokens + distinctTextTokens(knownText) + registeredMaterialTokens
    const registeredGrowth = 0
    let candidate = phase.mode === 'auto'
      ? selectAutoContextBudgetV1({
          requiredInputTokens,
          capability,
          outputReserve,
          registeredNextGrowth: registeredGrowth,
          autoMaxBudget: phase.autoMaxBudget,
          currentBudget: phase.selectedBudget,
          phaseChanged: startNewPhase,
          consecutiveLowBoundaries: startNewPhase ? 0 : phase.consecutiveLowBoundaries,
          losslessProjectionFitsCandidate: false
        })
      : null
    if (candidate?.ok && candidate.deferredDownshift && candidate.candidateBudget !== null) {
      const projectedCalculation = calculateContextBudgetV1({
        capability,
        outputReserve,
        selectedBudget: candidate.candidateBudget,
        registeredNextGrowth: registeredGrowth
      })
      const losslessProjectionFitsCandidate =
        snapshot.inputTokens !== null && projectedCalculation.reviewLine !== null &&
        snapshot.inputTokens < projectedCalculation.reviewLine
      if (losslessProjectionFitsCandidate) {
        candidate = selectAutoContextBudgetV1({
          requiredInputTokens,
          capability,
          outputReserve,
          registeredNextGrowth: registeredGrowth,
          autoMaxBudget: phase.autoMaxBudget,
          currentBudget: phase.selectedBudget,
          phaseChanged: startNewPhase,
          consecutiveLowBoundaries: startNewPhase ? 0 : phase.consecutiveLowBoundaries,
          losslessProjectionFitsCandidate: true
        })
      }
    }
    const calculation = calculateContextBudgetV1({
      capability,
      outputReserve,
      selectedBudget: candidate?.ok ? candidate.selectedBudget : phase.selectedBudget,
      registeredNextGrowth: registeredGrowth
    })
    const candidateBudget = candidate?.candidateBudget ?? null
    const candidateSoftLine = candidateBudget === null
      ? null
      : calculateContextBudgetV1({
          capability,
          outputReserve,
          selectedBudget: candidateBudget,
          registeredNextGrowth: registeredGrowth
        }).reviewLine
    const boundaryId = this.currentBudgetBoundaryId()
    const requestNeedsAction =
      !calculation.ok ||
      calculation.reviewLine === null ||
      requiredInputTokens >= calculation.reviewLine ||
      (phase.mode === 'auto' && !candidate?.ok)
    const chosen = phase.mode === 'auto' && candidate?.ok ? candidate.selectedBudget : phase.selectedBudget
    const nextSelectionReason = phase.mode === 'auto' && candidate?.ok
      ? `${reason}; ${candidate.reason}`
      : reason
    const boundaryFactsChanged =
      phase.lastRequiredInputTokens !== requiredInputTokens ||
      phase.lastCandidateBudget !== candidateBudget ||
      phase.lastCandidateSoftLine !== candidateSoftLine ||
      phase.lastAdjustBoundaryId !== boundaryId
    const updateNeeded = startNewPhase || materialsChanged || chosen !== phase.selectedBudget ||
      phase.selectionReason !== nextSelectionReason || boundaryFactsChanged
    if (!updateNeeded) {
      const status = requestNeedsAction
        ? 'needs_action'
        : phase.mode === 'fixed'
          ? 'fixed_by_user'
          : candidate?.reason ?? 'unchanged'
      return {
        data: {
          status,
          phaseId,
          selectedBudget: phase.selectedBudget,
          requiredInputTokens,
          reviewLine: calculation.reviewLine,
          hardInputLimit: calculation.hardInputLimit,
          actionReason: requestNeedsAction ? (candidate?.reason ?? calculation.reason) : undefined,
          countMode: 'estimated',
          calculation,
          materials: phase.materials
        },
        summary: {
          kind: 'context-budget', action: 'adjust', status,
          selectedBudget: phase.selectedBudget, phaseId
        }
      }
    }

    try {
      const updated = await contextBudgetStoreV1.update(sessionId, expectedRevision, (current) => {
        const currentPhase = current.phases[previousPhaseId]
        if (!currentPhase || current.activePhaseId !== previousPhaseId) {
          throw new ContextBudgetStoreError('invalid_phase', '当前任务阶段已不存在或已发生变化')
        }
        const nextPhase: ContextBudgetSessionPolicyV1['phases'][string] = {
          ...currentPhase,
          phaseId,
          selectedBudget: phase.mode === 'auto' && candidate?.ok ? candidate.selectedBudget : currentPhase.selectedBudget,
          selectionSource: phase.mode === 'auto' && candidate?.ok ? 'agent' : currentPhase.selectionSource,
          selectionReason: nextSelectionReason,
          materialRevision: startNewPhase || materialsChanged ? randomUUID() : currentPhase.materialRevision,
          materials: nextMaterials,
          consecutiveLowBoundaries: startNewPhase ? 0 : currentPhase.consecutiveLowBoundaries,
          ...(startNewPhase ? { lastBoundaryRevision: undefined } : {}),
          lastAdjustBoundaryId: boundaryId ?? undefined,
          lastRequiredInputTokens: requiredInputTokens,
          lastCandidateBudget: candidateBudget,
          lastCandidateSoftLine: candidateSoftLine
        }
        return {
          ...current,
          activePhaseId: phaseId,
          phases: {
            ...current.phases,
            [phaseId]: nextPhase
          }
        }
      })
      const selected = updated.phases[phaseId]
      const selectedCalc = calculateContextBudgetV1({
        capability,
        outputReserve,
        selectedBudget: selected.selectedBudget,
        registeredNextGrowth: registeredGrowth
      })
      const status = requestNeedsAction
        ? 'needs_action'
        : phase.mode === 'fixed'
          ? 'fixed_by_user'
          : candidate?.ok
            ? candidate.changed ? 'applied' : candidate.reason
            : 'needs_action'
      return {
        data: {
          status,
          phaseId,
          selectedBudget: selected.selectedBudget,
          requiredInputTokens,
          reviewLine: selectedCalc.reviewLine,
          hardInputLimit: selectedCalc.hardInputLimit,
          actionReason: requestNeedsAction ? (candidate?.reason ?? selectedCalc.reason) : undefined,
          countMode: 'estimated',
          selectionReason: selected.selectionReason,
          calculation: selectedCalc,
          materialRevision: selected.materialRevision,
          materials: selected.materials
        },
        summary: {
          kind: 'context-budget', action: 'adjust', status,
          selectedBudget: selected.selectedBudget,
          phaseId,
          registeredMaterials: selected.materials.filter((material) => material.status === 'available').length
        }
      }
    } catch (error) {
      if (error instanceof ContextBudgetStoreError) {
        throw new CapabilityCommandError(`context_budget_${error.code}`, error.message)
      }
      throw new CapabilityCommandError('context_budget_update_failed', '上下文预算调整没有提交；原策略与材料清单保留')
    }
  }

  async readPreparedBudgetSnapshot(sessionId: string): Promise<{
    endpoint: {
      provider: string
      api: string
      modelId: string
      endpointKey: string | null
      contextWindow: number | null
      maxOutputTokens: number | null
      outputReserve: number | null
    }
    inputTokens: number | null
    systemTokens: number
    toolsTokens: number
    observedAt: number
  } | null> {
    try {
      const raw = JSON.parse(await readFile(join(YAN_DIR, 'context-budget-v1', sessionId, 'latest-request.json'), 'utf8')) as Record<string, unknown>
      const endpoint = raw.endpoint as Record<string, unknown> | undefined
      if (
        raw.version !== 1 || raw.stage !== 'final' || raw.sessionId !== sessionId ||
        typeof raw.observedAt !== 'number' || !Number.isSafeInteger(raw.observedAt) || raw.observedAt < 0 ||
        raw.observedAt > Date.now() + 60_000 || Date.now() - raw.observedAt > 10 * 60_000 ||
        !endpoint || typeof endpoint.provider !== 'string' || typeof endpoint.api !== 'string' ||
        typeof endpoint.modelId !== 'string' ||
        !Number.isSafeInteger(raw.systemTokens) || !Number.isSafeInteger(raw.toolsTokens)
      ) return null
      return {
        endpoint: {
          provider: endpoint.provider,
          api: endpoint.api,
          modelId: endpoint.modelId,
          endpointKey: typeof endpoint.endpointKey === 'string' ? endpoint.endpointKey : null,
          contextWindow: Number.isSafeInteger(endpoint.contextWindow) ? endpoint.contextWindow as number : null,
          maxOutputTokens: Number.isSafeInteger(endpoint.maxOutputTokens) ? endpoint.maxOutputTokens as number : null,
          outputReserve: Number.isSafeInteger(endpoint.outputReserve) ? endpoint.outputReserve as number : null
        },
        systemTokens: raw.systemTokens as number,
        toolsTokens: raw.toolsTokens as number,
        inputTokens: Number.isSafeInteger(raw.inputTokens) ? raw.inputTokens as number : null,
        observedAt: raw.observedAt as number
      }
    } catch {
      return null
    }
  }

  /** 由最近一次真实请求与当前模型推出端点容量（adjust 与回合末回收共用，口径一致） */
  budgetCapabilityOf(
    snapshot: NonNullable<Awaited<ReturnType<ContextBudgetCommands['readPreparedBudgetSnapshot']>>>,
    model: NonNullable<SessionState['model']>
  ): { outputReserve: number | null; capability: EndpointBudgetCapabilityV1 | null } {
    const contextWindow = typeof model.contextWindow === 'number' && Number.isSafeInteger(model.contextWindow)
      ? model.contextWindow
      : snapshot.endpoint.contextWindow
    const maxOutputTokens = typeof model.maxTokens === 'number' && Number.isSafeInteger(model.maxTokens)
      ? model.maxTokens
      : snapshot.endpoint.maxOutputTokens
    const outputReserve = Number.isSafeInteger(snapshot.endpoint.outputReserve) && (snapshot.endpoint.outputReserve as number) > 0
      ? snapshot.endpoint.outputReserve as number
      : null
    const capability: EndpointBudgetCapabilityV1 | null =
      contextWindow && maxOutputTokens && outputReserve !== null && outputReserve > 0 && snapshot.endpoint.endpointKey
        ? {
            endpointKey: snapshot.endpoint.endpointKey,
            modelId: model.id,
            mode: 'shared',
            contextWindow,
            maxOutputTokens,
            countingAdapter: 'pi-pre-provider-estimate-v1',
            outputAccounting: 'shared-window-request-output-limit',
            revision: `${snapshot.endpoint.endpointKey}:${contextWindow}:${maxOutputTokens}`,
            source: 'runtime'
          }
        : null
    return { outputReserve, capability }
  }

  /** 回合结束：先记 adjust 路径的低用量边界，再按实际请求规模回收档位（串行，避免版本冲突） */
  async settleContextBudgetTurn(): Promise<void> {
    await this.recordContextBudgetBoundary()
    await this.reconcileContextBudgetFromObservedInput()
  }

  /**
   * 按这一回合最后一次真实请求的输入量回收档位（需求稿 8.3）。
   *
   * 只在自动模式下降档；用户固定档位不动。本回合 agent 已经 adjust 过时交给 adjust 路径，
   * 这里不重复计数。每回合最多计一次（lastBoundaryRevision 去重）。失败只会推迟降档，
   * 不会放宽任何请求门禁。
   */
  async reconcileContextBudgetFromObservedInput(): Promise<void> {
    const sessionId = this.host.state()?.sessionId
    const boundaryId = this.currentBudgetBoundaryId()
    const model = this.host.state()?.model
    if (!isSafeSessionId(sessionId) || !boundaryId || !model?.endpointKey) return
    try {
      if (!(await contextBudgetStoreV1.isConfigured(sessionId))) return
      const policy = await contextBudgetStoreV1.read(sessionId)
      const phaseId = policy.activePhaseId
      const phase = policy.phases[phaseId]
      if (!phase || phase.mode !== 'auto') return
      if (phase.lastAdjustBoundaryId === boundaryId || phase.lastBoundaryRevision === boundaryId) return
      /*
       * 临时抬线生效期间不动基础档：用户刚手动抬过，此刻再自动回收会让人以为出口没生效
       * （界面同时写着「临时抬线中」，基础档却惄惄变了，仍然不可解释）。
       * 抬线到期后自动回落，回收逻辑自然继续工作。
       */
      if (
        effectiveContextBudgetTierV1({
          selectedBudget: phase.selectedBudget,
          temporaryBudgetOverride: phase.temporaryBudgetOverride
        }) !== phase.selectedBudget
      ) return
      const snapshot = await this.readPreparedBudgetSnapshot(sessionId)
      if (!snapshot || snapshot.endpoint.endpointKey !== model.endpointKey || snapshot.endpoint.modelId !== model.id) return
      const { outputReserve, capability } = this.budgetCapabilityOf(snapshot, model)
      const verdict = reconcileObservedContextBudgetV1({
        observedInputTokens: snapshot.inputTokens,
        capability,
        outputReserve,
        currentBudget: phase.selectedBudget,
        previousLowTurns: phase.consecutiveLowBoundaries
      })
      /* 没有变化就不写盘 */
      if (!verdict.lowTurn && phase.consecutiveLowBoundaries === 0) return
      await contextBudgetStoreV1.update(sessionId, policy.revision, (current) => {
        const currentPhase = current.phases[phaseId]
        if (current.activePhaseId !== phaseId || !currentPhase || currentPhase.mode !== 'auto') {
          throw new ContextBudgetStoreError('invalid_phase', '任务阶段已变化，未回收档位')
        }
        const nextPhase = verdict.apply && verdict.candidateBudget !== null
          ? {
              ...currentPhase,
              selectedBudget: verdict.candidateBudget,
              selectionSource: 'host-reconcile' as const,
              selectionReason: `${verdict.reason}: 实际输入 ${snapshot.inputTokens} tokens，连续 ${verdict.lowTurns} 个回合低于 ${verdict.candidateBudget} 档软线的 60%`,
              consecutiveLowBoundaries: 0,
              lastBoundaryRevision: boundaryId
            }
          : { ...currentPhase, consecutiveLowBoundaries: verdict.lowTurns, lastBoundaryRevision: boundaryId }
        return { ...current, phases: { ...current.phases, [phaseId]: nextPhase } }
      })
    } catch {
      /* 版本冲突或读写失败：下一个回合再评估 */
    }
  }

  currentBudgetBoundaryId(): string | null {
    for (let index = this.host.messages().length - 1; index >= 0; index--) {
      const message = this.host.messages()[index]
      if (message.role !== 'user') continue
      return typeof message.id === 'string' && message.id ? message.id : null
    }
    return null
  }

  /** Count at most one low-use boundary per completed user turn for downshift hysteresis. */
  async recordContextBudgetBoundary(): Promise<void> {
    const sessionId = this.host.state()?.sessionId
    const boundaryId = this.currentBudgetBoundaryId()
    if (!isSafeSessionId(sessionId) || !boundaryId) return
    try {
      if (!(await contextBudgetStoreV1.isConfigured(sessionId))) return
      const policy = await contextBudgetStoreV1.read(sessionId)
      const phaseId = policy.activePhaseId
      const phase = policy.phases[phaseId]
      if (
        !phase || phase.mode !== 'auto' || phase.lastBoundaryRevision === boundaryId ||
        phase.lastAdjustBoundaryId !== boundaryId || phase.lastCandidateBudget === null ||
        phase.lastCandidateBudget === undefined || phase.lastRequiredInputTokens === undefined ||
        phase.lastCandidateSoftLine === null || phase.lastCandidateSoftLine === undefined
      ) return
      const model = this.host.state()?.model
      const snapshot = await this.readPreparedBudgetSnapshot(sessionId)
      if (!model?.endpointKey || snapshot?.endpoint.endpointKey !== model.endpointKey) return
      const lowBoundary =
        phase.lastCandidateBudget < phase.selectedBudget &&
        phase.lastRequiredInputTokens <= Math.floor(phase.lastCandidateSoftLine * 0.8)
      const consecutiveLowBoundaries = lowBoundary
        ? Math.min(2, phase.consecutiveLowBoundaries + 1)
        : 0
      await contextBudgetStoreV1.update(sessionId, policy.revision, (current) => {
        if (current.activePhaseId !== phaseId) {
          throw new ContextBudgetStoreError('invalid_phase', '任务阶段已变化，未记录降档边界')
        }
        const currentPhase = current.phases[phaseId]
        if (!currentPhase || currentPhase.lastAdjustBoundaryId !== boundaryId) {
          throw new ContextBudgetStoreError('stale_revision', '任务预算在记录边界前已更新')
        }
        return {
          ...current,
          phases: {
            ...current.phases,
            [phaseId]: {
              ...currentPhase,
              consecutiveLowBoundaries,
              lastBoundaryRevision: boundaryId
            }
          }
        }
      })
    } catch {
      /* A missed low-use count only delays a downshift; it never weakens a request guard. */
    }
  }

  async currentBudgetTaskStateTexts(sessionId: string): Promise<string[]> {
    const sessionFile = this.host.state()?.sessionFile
    if (!sessionFile) throw new Error('当前会话原始记录不可用，不能安全估算任务状态')
    const index = await readSessionEntryIndex(sessionFile)
    if (
      !index || index.sessionId !== sessionId || index.incompleteTail || index.unreadableEntries > 0
    ) {
      throw new Error('当前会话原始记录索引不完整，暂不按缺少任务状态计算')
    }
    let text: string
    try {
      text = await readFile(contextStatePath(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw new Error('任务状态无法安全读取，暂不按空状态计算')
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      throw new Error('任务状态 JSON 无效，暂不按空状态计算')
    }
    const inspected = inspectContextStateFile(raw, { knownEntryIds: index.entryIds })
    if (inspected.status !== 'ok' || inspected.state.sessionId !== sessionId) {
      throw new Error('任务状态格式或会话归属不可核实，暂不按空状态计算')
    }
    const watermark = inspected.state.sourceWatermark
    if (
      watermark.entryCount !== index.watermark.entryCount ||
      watermark.lastEntryId !== index.watermark.lastEntryId
    ) throw new Error('任务状态已落后于原始会话记录；请先刷新状态后再调档')
    return activeTaskStateTexts(inspected.state)
  }

  async scanContextBudgetMaterial(
    sessionId: string,
    phaseId: string,
    input: Record<string, unknown>,
    maxBytes: number
  ): Promise<{ material: ContextBudgetMaterialRecordV1; content: string; readBytes: number }> {
    const sourceRef = typeof input.path === 'string' ? input.path.trim() : ''
    const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : ''
    if (!sourceRef || !purpose || purpose.length > 1000 || isAbsolute(sourceRef) || sourceRef.includes('\0')) {
      throw new CapabilityCommandError('context_budget_material_invalid', '材料 path 必须是项目内相对路径，并附简短 purpose')
    }
    const normalized = sourceRef.replace(/[\\/]+/g, sep)
    const parts = normalized.split(sep)
    if (parts.some((part) => part === '..' || part === '.')) {
      throw new CapabilityCommandError('context_budget_material_path_invalid', '材料路径不能包含 . 或 .. 路径段')
    }
    let root: string
    let file: string
    try {
      root = await realpath(this.host.cwd())
      file = await realpath(resolve(root, normalized))
    } catch {
      throw new CapabilityCommandError('context_budget_material_missing', `材料文件不存在或不可读：${sourceRef}`)
    }
    const rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new CapabilityCommandError('context_budget_material_path_invalid', '材料必须位于当前项目工作目录内')
    }
    const details = await stat(file)
    if (!details.isFile() || details.size > 8 * 1024 * 1024 || details.size > maxBytes) {
      throw new CapabilityCommandError('context_budget_material_size_invalid', '单个材料与本次扫描合计不得超过 8 MiB；大文件请分次提供更小范围')
    }
    const bytes = await readFile(file)
    if (bytes.includes(0)) throw new CapabilityCommandError('context_budget_material_binary', '二进制材料当前不能作为文本预算材料登记')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new CapabilityCommandError('context_budget_material_encoding', '材料不是有效 UTF-8 文本，未登记')
    }
    let range: ContextBudgetMaterialRecordV1['range']
    if (input.range !== undefined) {
      if (!isPlainRecord(input.range) || !Number.isSafeInteger(input.range.start) || !Number.isSafeInteger(input.range.end)) {
        throw new CapabilityCommandError('context_budget_material_range_invalid', 'range 需要 start/end 字符索引')
      }
      const start = input.range.start as number
      const end = input.range.end as number
      if (start < 0 || end <= start || end > text.length) {
        throw new CapabilityCommandError('context_budget_material_range_invalid', `range 必须满足 0 <= start < end <= ${text.length}`)
      }
      range = { start, end, unit: 'chars' }
      text = text.slice(start, end)
    }
    const contentHash = createHash('sha256').update(text).digest('hex')
    const canonicalRef = relative(root, file).split(sep).join('/')
    const identity = `${sessionId}\0${phaseId}\0${canonicalRef}\0${range ? `${range.start}:${range.end}` : '*'}\0${contentHash}`
    const id = `mat-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
    return {
      material: {
        id,
        phaseId,
        sourceRef: canonicalRef,
        sourceVersion: `${details.size}:${Math.trunc(details.mtimeMs)}`,
        contentHash,
        ...(range ? { range } : {}),
        requiredTogether: input.requiredTogether === true,
        pinnedByUser: false,
        tokenEstimate: estimateTextTokensV1(text),
        status: 'available',
        purpose
      },
      content: text,
      readBytes: bytes.byteLength
    }
  }
}
