import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  checkContextBudgetRequestV1,
  contextEndpointKeyV1,
  resolveContextBudgetOutputReserveV1
} from './generated/context-budget-v1.mjs'
import { estimateRequestTokens } from './context-budget.js'
import { readContextBudgetPolicyV1 } from './context-budget-policy.js'
import { maintainContextAutomatically } from './context-budget-maintenance.js'

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.()
    return typeof id === 'string' && SESSION_ID_RE.test(id) && id !== '.' && id !== '..' ? id : null
  } catch {
    return null
  }
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function actualOutputReserve(api, payload, model) {
  return resolveContextBudgetOutputReserveV1({
    api,
    payload,
    compat: model?.compat
  })
}

function dataDir() {
  const dir = process.env.YAN_DATA_DIR?.trim()
  return dir || join(homedir(), '.pi', 'agent', 'yan')
}

export { readContextBudgetPolicyV1 } from './context-budget-policy.js'

function writePreparedSnapshot(sessionId, payload, ctx, check) {
  const usage = estimateRequestTokens(payload)
  const provider = typeof ctx?.model?.provider === 'string' ? ctx.model.provider : ''
  const modelId = typeof ctx?.model?.id === 'string' ? ctx.model.id : ''
  const api = typeof ctx?.model?.api === 'string' ? ctx.model.api : ''
  const endpointKey = contextEndpointKeyV1({
    provider,
    api,
    modelId,
    baseUrl: ctx?.model?.baseUrl
  })
  const contextWindow = safeInteger(ctx?.model?.contextWindow)
  const maxOutputTokens = safeInteger(ctx?.model?.maxTokens)
  const output = actualOutputReserve(api, payload, ctx?.model)
  const outputReserve = output.outputReserve
  const record = {
    version: 1,
    stage: 'final',
    sessionId,
    requestRevision: randomUUID(),
    observedAt: Date.now(),
    countMode: usage && safeInteger(usage?.total) !== null ? 'estimated' : 'unavailable',
    inputTokens: safeInteger(usage?.total),
    messagesTokens: safeInteger(usage?.messages),
    toolsTokens: safeInteger(usage?.tools),
    systemTokens: safeInteger(usage?.system),
    endpoint: {
      provider,
      api,
      modelId,
      endpointKey,
      contextWindow,
      maxOutputTokens,
      outputReserve,
      outputAdapter: output.adapterId
    },
    check
  }
  const dir = join(dataDir(), 'context-budget-v1', sessionId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'latest-request.json')
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* keep the previous snapshot intact */ }
    throw error
  }
}

function writeBlockedEntry(pi, sessionId, inputTokens, calculation, code, reason) {
  try {
    pi?.appendEntry?.('yan-context-budget-v1', {
      at: Date.now(),
      sessionId,
      code,
      reason: String(reason ?? code).slice(0, 500),
      inputTokens,
      selectedBudget: calculation?.selectedBudget ?? null,
      reviewLine: calculation?.reviewLine ?? null,
      hardInputLimit: calculation?.hardInputLimit ?? null,
      strategy: 'budget-v1'
    })
  } catch {
    /* The guard still aborts if a diagnostic entry cannot be written. */
  }
}

function unavailableDetails(reason, code = 'context_budget_unavailable') {
  const fallback = defaultPolicy()
  const result = checkContextBudgetRequestV1({
    inputTokens: null,
    outputReserve: null,
    countMode: 'unavailable',
    capability: null,
    selectedBudget: fallback.selectedBudget
  })
  return {
    decision: 'unavailable',
    code,
    reason: String(reason ?? code).slice(0, 500),
    policyRevision: null,
    phaseId: fallback.phaseId,
    selectionMode: fallback.mode,
    selectionReason: '',
    selectedBudget: fallback.selectedBudget,
    autoMaxBudget: fallback.autoMaxBudget,
    inputTokens: null,
    calculation: result.calculation
  }
}

async function checkAndAbort(pi, ctx, sessionId, payload, policy) {
  if (policy.unavailable) {
    writeBlockedEntry(pi, sessionId, null, null, 'context_budget_unavailable', policy.unavailable)
    try { ctx?.abort?.() } catch { /* no retry through this guard */ }
    return unavailableDetails(policy.unavailable)
  }
  const usage = estimateRequestTokens(payload)
  const contextWindow = safeInteger(ctx?.model?.contextWindow)
  const maxOutputTokens = safeInteger(ctx?.model?.maxTokens)
  const provider = typeof ctx?.model?.provider === 'string' ? ctx.model.provider : ''
  const modelId = typeof ctx?.model?.id === 'string' ? ctx.model.id : ''
  const api = typeof ctx?.model?.api === 'string' ? ctx.model.api : ''
  const output = actualOutputReserve(api, payload, ctx?.model)
  const outputReserve = output.outputReserve
  const maxInputTokens = safeInteger(ctx?.model?.maxInputTokens)
  const endpointKey = contextEndpointKeyV1({ provider, api, modelId, baseUrl: ctx?.model?.baseUrl })
  const capability = contextWindow && maxOutputTokens && provider && modelId && endpointKey &&
    output.adapterId !== 'unsupported' && output.adapterId !== 'unknown'
    ? {
        endpointKey,
        modelId,
        mode: maxInputTokens ? 'separate' : 'shared',
        contextWindow,
        ...(maxInputTokens ? { maxInputTokens } : {}),
        maxOutputTokens,
        countingAdapter: `pi-pre-provider-estimate-v1/${output.adapterId}`,
        outputAccounting: output.adapterId,
        revision: `${endpointKey}:${contextWindow}:${maxOutputTokens}:${output.adapterId}`,
        source: 'runtime'
      }
    : null
  const result = checkContextBudgetRequestV1({
    inputTokens: safeInteger(usage?.total),
    outputReserve,
    countMode: usage && safeInteger(usage.total) !== null ? 'estimated' : 'unavailable',
    capability,
    selectedBudget: policy.selectedBudget
  })
  const details = {
    decision: result.decision,
    reason: result.reason,
    policyRevision: policy.policyRevision ?? null,
    phaseId: policy.phaseId,
    selectionMode: policy.mode,
    selectionReason: policy.selectionReason ?? '',
    selectedBudget: policy.selectedBudget,
    autoMaxBudget: policy.autoMaxBudget,
    inputTokens: safeInteger(usage?.total),
    outputAdapter: output.adapterId,
    outputResolutionReason: output.reason,
    calculation: result.calculation
  }
  if (result.decision === 'send') return details

  const code = result.decision === 'blocked'
    ? 'context_capacity_blocked'
    : result.decision === 'review'
      ? 'context_review_required'
      : 'context_budget_unavailable'
  writeBlockedEntry(pi, sessionId, details.inputTokens, result.calculation, code, result.reason)
  if ((result.decision === 'review' || result.decision === 'blocked') && capability) {
    try {
      const maintenance = await maintainContextAutomatically(pi, ctx, code)
      pi?.appendEntry?.('yan-context-maintenance', {
        at: Date.now(),
        sessionId,
        operationId: maintenance.operation?.identity?.operationId ?? null,
        state: maintenance.operation?.state ?? 'needs_action',
        code: maintenance.ok ? 'automatic_projection_committed' : 'automatic_projection_needs_action',
        failureCode: maintenance.ok ? null : String(maintenance.error ?? 'automatic_maintenance_failed').slice(0, 300)
      })
    } catch (error) {
      try {
        pi?.appendEntry?.('yan-context-maintenance', {
          at: Date.now(),
          sessionId,
          state: 'needs_action',
          code: 'automatic_projection_needs_action',
          failureCode: String(error instanceof Error ? error.message : error).slice(0, 300)
        })
      } catch { /* the original budget guard remains authoritative */ }
    }
  }
  try { ctx?.abort?.() } catch { /* Abort is best effort; no throw-based fallback. */ }
  return { ...details, code }
}

/** Capture the last post-extension request shape for host-side reconciliation. */
export default function contextBudgetObserver(pi) {
  pi.on('before_provider_request', async (event, ctx) => {
    const sessionId = sessionIdOf(ctx)
    if (!sessionId || !event?.payload || typeof event.payload !== 'object') {
      try { ctx?.abort?.() } catch { /* Missing request identity or payload fails closed. */ }
      return
    }
    const policy = readContextBudgetPolicyV1(sessionId)
    if (policy.inactive) return
    let check
    try {
      check = await checkAndAbort(pi, ctx, sessionId, event.payload, policy)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'context_budget_guard_error'
      writeBlockedEntry(pi, sessionId, null, null, 'context_budget_unavailable', reason)
      try { ctx?.abort?.() } catch { /* Guard errors do not fall through to provider send. */ }
      check = unavailableDetails(reason)
    }
    try {
      writePreparedSnapshot(sessionId, event.payload, ctx, check)
    } catch {
      /* Snapshot failure does not weaken the request check or change its result. */
    }
  })
  pi.on('session_before_compact', (event, ctx) => blockNativeContextCompactionV1(pi, ctx, event))
}

function blockNativeContextCompactionV1(pi, ctx, event) {
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return { cancel: true }
  const policy = readContextBudgetPolicyV1(sessionId)
  if (policy.inactive) return undefined
  const reason = policy.unavailable
    ? policy.unavailable
    : 'context_v1_maintenance_coordinator_not_available'
  writeBlockedEntry(
    pi,
    sessionId,
    null,
    null,
    'context_maintenance_required',
    `${reason}; native compaction was cancelled (${String(event?.reason ?? 'unknown')})`
  )
  return { cancel: true }
}
