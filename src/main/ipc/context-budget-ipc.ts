/**
 * 上下文预算与整理读数的 IPC 适配（`yan:contextBudget*`、`yan:contextActions`）。
 *
 * 都按当前前台会话取值；预算设置写入带 `expectedRevision`，版本不对就报错不覆盖。
 */
import type { IpcRegistrar } from './registrar'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { activeContextPolicy, contextPolicySettings } from '../context-policy'
import { contextBudget } from '../../shared/context-policy'
import { isContextBudgetTierV1, sanitizeContextBudgetRuntimeSnapshotV1 } from '../../shared/context-budget-v1'
import { ContextBudgetStoreError, contextBudgetStoreV1 } from '../context-budget-store'
import { modelKeyOf } from '../../shared/model-capabilities'
import { randomUUID } from 'node:crypto'
import { readContextActions } from '../context-actions'
import { YAN_DIR } from '../paths'
import type { AgentController } from '../agent'

export interface ContextBudgetIpcDeps {
  /** 当前前台运行实例的控制器 */
  currentAgent(): AgentController | undefined
}

export function registerContextBudgetIpc(ipc: IpcRegistrar, deps: ContextBudgetIpcDeps): void {
  const { rawHandle } = ipc
  const { currentAgent } = deps
  /*
   * 工作集预算（N21-3）：**只算不决策**。
   * 界面上显示的工作集与砚真正用来判断过线的是同一份预算（同一个策略对象），
   * 测试也用它对照参考值（64k → 40k、128k → 88k、256k → 179k、1M → 240k）。
   */
  rawHandle('yan:contextBudget', (_e, win: unknown) => {
    /*
     * 用**当前会话模型**查表（N21-7）：模型级覆盖生效时，界面看到的预算
     * 必须与 agent 真正用的那份一致 —— 探针的“界面数 = 主进程数”靠这条。
     */
    const modelKey = modelKeyOf(currentAgent()?.getState()?.model)
    const resolved = activeContextPolicy(process.env, modelKey)
    /* 与 `AgentController.contextPolicyView()` 同口径：档位名要靠精确模型层原文判断 */
    const modelOverrides = modelKey ? contextPolicySettings().byModel?.[modelKey] : undefined
    return {
      policy: resolved.policy,
      budget: contextBudget(typeof win === 'number' ? win : 0, resolved.policy),
      source: resolved.source,
      ...(resolved.sourceKey ? { sourceKey: resolved.sourceKey } : {}),
      overridden: resolved.overridden,
      ...(modelOverrides ? { modelOverrides } : {})
    }
  })
  rawHandle('yan:contextBudgetV1', async () => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId) return null
    try {
      return await contextBudgetStoreV1.read(sessionId)
    } catch {
      return null
    }
  })
  rawHandle('yan:contextBudgetV1Enabled', async () => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId) return false
    try {
      return await contextBudgetStoreV1.isConfigured(sessionId)
    } catch {
      return false
    }
  })
  rawHandle('yan:contextBudgetSnapshotV1', async () => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || sessionId === '.' || sessionId === '..') return null
    try {
      const raw = JSON.parse(await readFile(join(YAN_DIR, 'context-budget-v1', sessionId, 'latest-request.json'), 'utf8')) as unknown
      return sanitizeContextBudgetRuntimeSnapshotV1(raw, sessionId)
    } catch {
      return null
    }
  })
  rawHandle('yan:contextBudgetMaintainV1', async (_e, operationId: unknown) => {
    try {
      return await currentAgent()?.requestContextMaintenanceV1(typeof operationId === 'string' ? operationId : undefined) ?? { ok: false, error: '当前没有活动会话' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '上下文整理未完成' }
    }
  })
  rawHandle('yan:contextBudgetMaintenanceStatusV1', async () => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId) return null
    try {
      return await contextBudgetStoreV1.latestOperation(sessionId)
    } catch {
      return null
    }
  })
  rawHandle('yan:setContextBudgetV1', async (_e, rawUpdate: unknown) => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId || !rawUpdate || typeof rawUpdate !== 'object') {
      return { ok: false, error: '当前没有可设置的活动会话' }
    }
    const update = rawUpdate as Record<string, unknown>
    if (
      typeof update.expectedRevision !== 'string' ||
      (update.mode !== 'auto' && update.mode !== 'fixed') ||
      (update.autoMaxBudget !== undefined && !isContextBudgetTierV1(update.autoMaxBudget)) ||
      (update.selectedBudget !== undefined && !isContextBudgetTierV1(update.selectedBudget))
    ) return { ok: false, error: '上下文预算设置格式无效' }
    if (update.mode === 'fixed' && !isContextBudgetTierV1(update.selectedBudget)) {
      return { ok: false, error: '固定模式必须选择一个有效档位' }
    }
    try {
      const current = await contextBudgetStoreV1.read(sessionId)
      const phaseId = current.activePhaseId
      const currentPhase = current.phases[phaseId]
      const autoMaxBudget = isContextBudgetTierV1(update.autoMaxBudget)
        ? update.autoMaxBudget
        : currentPhase.autoMaxBudget
      const selectedBudget = update.mode === 'fixed'
        ? update.selectedBudget as number
        : currentPhase.selectedBudget > autoMaxBudget
          ? autoMaxBudget
          : currentPhase.selectedBudget
      const policy = await contextBudgetStoreV1.update(sessionId, update.expectedRevision, (latest) => {
        const latestPhase = latest.phases[phaseId]
        if (!latestPhase) throw new ContextBudgetStoreError('invalid_phase', '当前任务阶段已不存在')
        return {
          ...latest,
          phases: {
            ...latest.phases,
            [phaseId]: {
              ...latestPhase,
              mode: update.mode as 'auto' | 'fixed',
              selectedBudget: selectedBudget as typeof latestPhase.selectedBudget,
              autoMaxBudget,
              selectionSource: 'user',
              selectionReason: update.mode === 'fixed' ? 'user_fixed_budget' : 'user_enabled_auto_budget'
            }
          }
        }
      })
      return { ok: true, policy }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '上下文预算设置未保存'
      }
    }
  })
  rawHandle('yan:setContextBudgetMaterialPinV1', async (_e, rawUpdate: unknown) => {
    const sessionId = currentAgent()?.getState()?.sessionId
    if (!sessionId || !rawUpdate || typeof rawUpdate !== 'object') {
      return { ok: false, error: '当前没有可设置的活动会话' }
    }
    const update = rawUpdate as Record<string, unknown>
    if (
      typeof update.expectedRevision !== 'string' ||
      typeof update.materialId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(update.materialId) ||
      typeof update.pinned !== 'boolean'
    ) return { ok: false, error: '固定材料设置格式无效' }
    try {
      const current = await contextBudgetStoreV1.read(sessionId)
      const phaseId = current.activePhaseId
      const phase = current.phases[phaseId]
      const material = phase?.materials.find((item) => item.id === update.materialId)
      if (!phase || !material) {
        return { ok: false, error: '这份材料已不在当前阶段，请刷新列表' }
      }
      if (update.pinned && !material.pinnedByUser && phase.materials.filter((item) => item.pinnedByUser).length >= 100) {
        return { ok: false, error: '每个阶段最多固定 100 份材料' }
      }
      const policy = await contextBudgetStoreV1.update(sessionId, update.expectedRevision, (latest) => {
        if (latest.activePhaseId !== phaseId) throw new ContextBudgetStoreError('invalid_phase', '当前任务阶段已发生变化')
        const latestPhase = latest.phases[phaseId]
        if (!latestPhase) throw new ContextBudgetStoreError('invalid_phase', '当前任务阶段已不存在')
        const materials = latestPhase.materials.map((material) =>
          material.id === update.materialId ? { ...material, pinnedByUser: update.pinned as boolean } : material
        )
        return {
          ...latest,
          phases: {
            ...latest.phases,
            [phaseId]: {
              ...latestPhase,
              materialRevision: randomUUID(),
              materials
            }
          }
        }
      })
      return { ok: true, policy }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '材料固定状态未保存'
      }
    }
  })

  /*
   * 三类整理动作账本（实施-11 C-2b）：`tool-sweep` / `episode-fold`
   * 不产生 pi 的 `compaction_*` 事件，界面只能从这里读到它们真实发生过。
   * 读不到就返回空统计 —— 诊断读数不该让界面报错。
   */
  rawHandle('yan:contextActions', () => readContextActions(currentAgent()?.getState()?.sessionId ?? null))
}
