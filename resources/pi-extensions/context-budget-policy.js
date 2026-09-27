import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  return {
    mode: phase.mode,
    selectedBudget: phase.selectedBudget,
    autoMaxBudget: phase.autoMaxBudget,
    phaseId: raw.activePhaseId,
    policyRevision: raw.revision,
    selectionReason: typeof phase.selectionReason === 'string' ? phase.selectionReason : ''
  }
}
