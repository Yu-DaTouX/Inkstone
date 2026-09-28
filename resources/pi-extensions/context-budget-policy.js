import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { effectiveContextBudgetTierV1 } from './generated/context-budget-v1.mjs'

function dataDir() {
  const dir = process.env.YAN_DATA_DIR?.trim()
  return dir || join(homedir(), '.pi', 'agent', 'yan')
}

/** Read the same session policy from each thin pi extension without coupling hooks. */
export function readContextBudgetPolicyV1(sessionId) {
  const path = join(dataDir(), 'context-budget-v1', sessionId, 'policy.json')
  let raw
  try {
    if (statSync(path).size > 16 * 1024 * 1024) return { unavailable: 'context_policy_too_large' }
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { inactive: true }
    return { unavailable: 'context_policy_unreadable' }
  }
  if (
    !raw || raw.version !== 1 || raw.sessionId !== sessionId ||
    typeof raw.revision !== 'string' || raw.revision.length < 8 || raw.revision.length > 100 ||
    typeof raw.activePhaseId !== 'string' ||
    !raw.phases || typeof raw.phases !== 'object' || Array.isArray(raw.phases)
  ) return { unavailable: 'context_policy_invalid' }
  const phase = raw.phases[raw.activePhaseId]
  const tiers = new Set([200_000, 300_000, 500_000, 700_000])
  if (
    !phase || phase.phaseId !== raw.activePhaseId ||
    (phase.mode !== 'auto' && phase.mode !== 'fixed') ||
    !tiers.has(phase.selectedBudget) || !tiers.has(phase.autoMaxBudget) ||
    !Array.isArray(phase.materials) || phase.materials.length > 500
  ) return { unavailable: 'context_policy_invalid' }
  /*
   * 临时抬线也必须在这里生效：宿主与扩展要得出**同一个**有效软线，
   * 分两处算就会出现「界面显示 300K、扩展仍按 200K 拦」这种无法解释的现象。
   * 过期的覆盖由 `effectiveContextBudgetTierV1` 当成不存在（惰性失效，不靠定时清理）。
   */
  const effective = effectiveContextBudgetTierV1({
    selectedBudget: phase.selectedBudget,
    temporaryBudgetOverride: phase.temporaryBudgetOverride
  })
  return {
    mode: phase.mode,
    selectedBudget: effective,
    autoMaxBudget: phase.autoMaxBudget,
    phaseId: raw.activePhaseId,
    policyRevision: raw.revision,
    selectionReason: typeof phase.selectionReason === 'string' ? phase.selectionReason : '',
    temporaryRaisedFrom: effective === phase.selectedBudget ? null : phase.selectedBudget
  }
}
