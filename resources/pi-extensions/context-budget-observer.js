import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONTEXT_BUDGET_V1_TIERS,
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

/**
 * payload 的**字符构成**（诊断用）。
 *
 * 为什么要它：`estimateRequestTokens` 与 provider 实际报的 prompt 差过 4 倍
 *（实测：留痕 109k，而 usage 里 input+cacheRead 是 440k）—— 光看总数不知道
 * 漏在哪一类内容。这里把 payload 按顶层键、以及 messages 里按 `type.字段`
 * 各占多少字符数写进留痕：下次对不上时，一眼能看出是「某一类内容没被算」
 * 还是「payload 本身就小」。
 */
export function payloadCensus(payload) {
  const byTopKey = {}
  const byBlockField = {}
  let chars = 0
  let blockChars = 0
  const walkValues = (value, topKey, depth) => {
    if (value === null || value === undefined || depth > 8) return
    if (typeof value === 'string') {
      chars += value.length
      byTopKey[topKey] = (byTopKey[topKey] ?? 0) + value.length
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walkValues(item, topKey, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    for (const item of Object.values(value)) walkValues(item, topKey, depth + 1)
  }
  for (const [key, value] of Object.entries(payload ?? {})) walkValues(value, key, 0)

  /* messages 里按「块类型.字段」细分：漏算往往就藏在某个字段名上 */
  const walkBlocks = (value, depth) => {
    if (value === null || value === undefined || depth > 8) return
    if (Array.isArray(value)) {
      for (const item of value) walkBlocks(item, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    const type = typeof value.type === 'string' ? value.type : ''
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        const name = type ? `${type}.${key}` : `(无类型).${key}`
        byBlockField[name] = (byBlockField[name] ?? 0) + item.length
        blockChars += item.length
        continue
      }
      walkBlocks(item, depth + 1)
    }
  }
  walkBlocks(payload?.messages, 0)

  const top = (bucket) =>
    Object.fromEntries(Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, 12))
  return { chars, blockChars, byTopKey: top(byTopKey), byBlockField: top(byBlockField) }
}

function actualOutputReserve(api, payload, model) {
  return resolveContextBudgetOutputReserveV1({
    api,
    payload,
    compat: model?.compat,
    modelMaxTokens: model?.maxTokens
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
    check,
    /* 估算与实际差得离谱时，这里能直接看出差在哪（见 payloadCensus 的说明） */
    payloadCensus: payloadCensus(payload)
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

/**
 * 策略读不到 / 坏掉时的兜底策略。
 *
 * 它只服务于「把不可用这件事写全」：宿主不拿它做判定
 *（`readPreparedBudgetSnapshot` 只读 endpoint 与 token 字段），
 * 但**形状必须合法** —— 界面那份 `sanitizeContextBudgetRuntimeSnapshotV1`
 * 会校验 `phaseId` 是非空字符串、`selectionMode` 是 auto/fixed、
 * 两个档位是合法档；缺一项整份快照会被丢掉（而不是显示成不可用）。
 *
 * 取值跟宿主新建会话的默认策略同口径
 *（`src/main/context-budget-store.ts` 的 `defaultPhase('main')`：
 * 最小档 200k + 最大自动档 700k）。
 *
 * ⚠️ 这个函数曾经**根本不存在**（`unavailableDetails` 直接调它）：
 * 于是「策略坏掉」这条兜底路径自己抛 `ReferenceError`，用户看到的是
 * 「扩展出错：defaultPolicy is not defined」——兜底比它要兜的错还脆。
 */
function defaultPolicy() {
  return {
    phaseId: 'main',
    mode: 'auto',
    selectedBudget: CONTEXT_BUDGET_V1_TIERS[0],
    autoMaxBudget: CONTEXT_BUDGET_V1_TIERS[3],
    policyRevision: null,
    selectionReason: ''
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
    selectionReason: fallback.selectionReason,
    selectedBudget: fallback.selectedBudget,
    autoMaxBudget: fallback.autoMaxBudget,
    inputTokens: null,
    calculation: result.calculation
  }
}

/*
 * 撞线后一次要摘掉多少：压到 targetAfterReview（软线的 75%）以下，
 * 再给新笔记留出余量（笔记会替换掉旧笔记，最长约 MAX_SUMMARY_CHARS 字符）。
 * 算不出时返回 undefined，整理按默认上限走。
 */
const NOTES_MARGIN_TOKENS = 12_000

function reductionTarget(inputTokens, calculation) {
  const target = safeInteger(calculation?.targetAfterReview)
  if (!Number.isFinite(inputTokens) || !target) return undefined
  const need = inputTokens - target + NOTES_MARGIN_TOKENS
  return need > 0 ? need : undefined
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
      const maintenance = await maintainContextAutomatically(pi, ctx, code, {
        targetTokens: reductionTarget(details.inputTokens, result.calculation)
      })
      pi?.appendEntry?.('yan-context-maintenance', {
        at: Date.now(),
        sessionId,
        inputTokens: details.inputTokens,
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
