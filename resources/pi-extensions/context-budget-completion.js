import {
  checkContextBudgetRequestV1,
  contextEndpointKeyV1,
  CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1
} from './generated/context-budget-v1.mjs'
import { estimateRequestTokens } from './context-budget.js'
import { readContextBudgetPolicyV1 } from './context-budget-policy.js'

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

export class ContextBudgetV1BlockedError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContextBudgetV1BlockedError'
    this.code = code
  }
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.()
    return typeof id === 'string' && SESSION_ID_RE.test(id) && id !== '.' && id !== '..' ? id : null
  } catch {
    return null
  }
}

function appendDecision(pi, sessionId, details) {
  try {
    pi?.appendEntry?.('yan-context-budget-v1', {
      at: Date.now(),
      sessionId,
      requestKind: details.requestKind,
      operationId: details.operationId,
      decision: details.decision,
      code: details.code ?? null,
      reason: details.reason,
      inputTokens: details.inputTokens,
      outputReserve: details.outputReserve,
      hardInputLimit: details.calculation?.hardInputLimit ?? null,
      reviewLine: details.calculation?.reviewLine ?? null,
      policyRevision: details.policyRevision ?? null,
      strategy: 'budget-v1'
    })
  } catch {
    /* Diagnostics are useful, but cannot weaken the guard. */
  }
}

function reject(pi, sessionId, requestKind, operationId, policyRevision, code, reason, inputTokens, outputReserve, calculation) {
  const details = {
    requestKind,
    operationId,
    decision: 'blocked',
    code,
    reason: String(reason ?? code).slice(0, 500),
    inputTokens,
    outputReserve,
    calculation,
    policyRevision
  }
  appendDecision(pi, sessionId, details)
  throw new ContextBudgetV1BlockedError(code, details.reason)
}

/**
 * Budget direct modelRegistry.complete calls that bypass pi's provider hook.
 * Legacy sessions without a V1 policy preserve their existing behavior.
 * Internal completions may cross the soft review line but can never cross H.
 */
export async function completeWithContextBudgetV1({
  pi,
  ctx,
  requestKind,
  operationId,
  registry,
  model,
  payload,
  options
}) {
  const sessionId = sessionIdOf(ctx)
  if (typeof registry?.complete !== 'function' || !model) {
    throw new ContextBudgetV1BlockedError('context_budget_unavailable', 'pi completion registry or current model is unavailable')
  }
  if (!sessionId) {
    reject(pi, null, requestKind, operationId, null, 'context_budget_unavailable', 'pi session identity is unavailable', null, null)
  }

  const policy = readContextBudgetPolicyV1(sessionId)
  if (policy.inactive) return await registry.complete(model, payload, options)
  if (policy.unavailable) {
    reject(pi, sessionId, requestKind, operationId, null, 'context_budget_unavailable', policy.unavailable, null, null)
  }

  const inputTokensRaw = estimateRequestTokens(payload)?.total
  const inputTokens = safeInteger(inputTokensRaw)
  const outputReserve = positiveInteger(options?.maxTokens)
  const contextWindow = positiveInteger(model?.contextWindow)
  const maxOutputTokens = positiveInteger(model?.maxTokens)
  const maxInputTokens = positiveInteger(model?.maxInputTokens)
  const provider = typeof model?.provider === 'string' ? model.provider : ''
  const modelId = typeof model?.id === 'string' ? model.id : ''
  const api = typeof model?.api === 'string' ? model.api : ''
  const outputAdapter = CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1[api]
  const endpointKey = contextEndpointKeyV1({ provider, api, modelId, baseUrl: model?.baseUrl })
  const capability = endpointKey && modelId && maxOutputTokens && outputAdapter
    ? {
        endpointKey,
        modelId,
        mode: maxInputTokens ? 'separate' : 'shared',
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxInputTokens ? { maxInputTokens } : {}),
        maxOutputTokens,
        countingAdapter: `pi-registry-complete-estimate-v1/${outputAdapter.adapterId}`,
        outputAccounting: outputAdapter.accounting,
        revision: `${endpointKey}:${contextWindow ?? 'unknown'}:${maxInputTokens ?? 'unknown'}:${maxOutputTokens}:${outputAdapter.adapterId}`,
        source: 'runtime'
      }
    : null
  const checked = checkContextBudgetRequestV1({
    inputTokens,
    outputReserve,
    countMode: inputTokens === null ? 'unavailable' : 'estimated',
    capability,
    selectedBudget: policy.selectedBudget
  })

  if (checked.decision === 'unavailable' || checked.decision === 'blocked') {
    reject(
      pi,
      sessionId,
      requestKind,
      operationId,
      policy.policyRevision,
      checked.decision === 'blocked' ? 'context_capacity_blocked' : 'context_budget_unavailable',
      checked.reason,
      inputTokens,
      outputReserve,
      checked.calculation
    )
  }

  const review = checked.decision === 'review'
  if (review) {
    appendDecision(pi, sessionId, {
      requestKind,
      operationId,
      decision: 'review',
      reason: checked.reason,
      inputTokens,
      outputReserve,
      calculation: checked.calculation,
      policyRevision: policy.policyRevision
    })
  }
  return await registry.complete(model, payload, options)
}
