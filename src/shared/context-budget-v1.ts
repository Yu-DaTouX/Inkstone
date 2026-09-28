/**
 * Context budget V1. This module is deliberately pure so the host, UI and the
 * thin pi boundary can share one definition without importing runtime state.
 */

export const CONTEXT_BUDGET_V1_TIERS = [200_000, 300_000, 500_000, 700_000] as const
export type ContextBudgetTierV1 = (typeof CONTEXT_BUDGET_V1_TIERS)[number]
export type ContextBudgetModeV1 = 'shared' | 'separate'
export type ContextBudgetCountModeV1 = 'exact' | 'estimated' | 'unavailable'
export type ContextBudgetRequestKindV1 = 'agent' | 'summary' | 'state' | 'deep' | 'handoff'
export type ContextBudgetDecisionV1 = 'send' | 'review' | 'blocked' | 'unavailable'

export interface EndpointBudgetCapabilityV1 {
  endpointKey: string
  modelId: string
  mode: ContextBudgetModeV1
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens: number
  countingAdapter: string
  outputAccounting: string
  revision: string
  source: 'runtime' | 'official-config' | 'user-override'
}

export interface ContextBudgetOutputAdapterV1 {
  api: string
  adapterId: string
  fieldPath: readonly string[] | 'openai-completions-compat'
  accounting: string
}

export interface ContextBudgetOutputResolutionV1 {
  adapterId: string
  outputReserve: number | null
  reason: string
}

export interface ContextBudgetCalculationV1 {
  ok: boolean
  reason: string
  capacityBasis: number | null
  hardInputLimit: number | null
  errorMargin: number | null
  growth: number
  selectedBudget: number
  reviewLine: number | null
  targetAfterReview: number | null
}

export interface ContextBudgetSnapshotV1 {
  version: 1
  strategy: 'budget-v1'
  sessionId: string
  runnerId: string
  phaseId: string
  operationId?: string
  requestRevision: string
  policyRevision: string
  capabilityRevision: string
  requestKind: ContextBudgetRequestKindV1
  stage: 'prepared' | 'final'
  countMode: ContextBudgetCountModeV1
  inputTokens: number | null
  outputReserve: number | null
  margin: number | null
  growth: number
  selectedBudget: number
  selectionMode: 'auto' | 'fixed'
  autoMaxBudget: number
  selectionSource: 'agent' | 'host-reconcile' | 'user' | 'default'
  selectionReason: string
  materialRevision: string
  hardInputLimit: number | null
  reviewLine: number | null
  targetAfterReview: number | null
  protectedTokens: number | null
  decision: ContextBudgetDecisionV1
  reason: string
}

export interface ContextBudgetRuntimeSnapshotV1 {
  version: 1
  stage: 'final'
  sessionId: string
  requestRevision: string
  observedAt: number
  countMode: ContextBudgetCountModeV1
  inputTokens: number | null
  messagesTokens: number | null
  toolsTokens: number | null
  systemTokens: number | null
  outputReserve: number | null
  endpoint: {
    provider: string
    modelId: string
    endpointKey: string | null
  }
  check: {
    decision: ContextBudgetDecisionV1
    reason: string
    phaseId: string
    selectionMode: 'auto' | 'fixed'
    selectionReason: string
    selectedBudget: ContextBudgetTierV1
    autoMaxBudget: ContextBudgetTierV1
    calculation: ContextBudgetCalculationV1
  }
}

export interface AutoBudgetSelectionInputV1 {
  requiredInputTokens: number
  capability: EndpointBudgetCapabilityV1
  outputReserve: number
  registeredNextGrowth?: number
  autoMaxBudget: number
  currentBudget: number
  phaseChanged?: boolean
  consecutiveLowBoundaries?: number
  losslessProjectionFitsCandidate?: boolean
}

export interface AutoBudgetSelectionV1 {
  ok: boolean
  selectedBudget: ContextBudgetTierV1
  candidateBudget: ContextBudgetTierV1 | null
  reason: string
  changed: boolean
  deferredDownshift: boolean
  calculation: ContextBudgetCalculationV1
}

export interface ContextBudgetRequestCheckInputV1 {
  inputTokens: number | null
  outputReserve: number | null
  countMode: ContextBudgetCountModeV1
  capability: EndpointBudgetCapabilityV1 | null
  selectedBudget: number
  registeredNextGrowth?: number
}

export interface ContextBudgetRequestCheckV1 {
  decision: ContextBudgetDecisionV1
  reason: string
  calculation: ContextBudgetCalculationV1
}

export interface ContextBudgetMaterialRecordV1 {
  id: string
  phaseId: string
  sourceRef: string
  sourceVersion: string
  contentHash: string
  range?: { start: number; end: number; unit: 'chars' | 'bytes' }
  requiredTogether: boolean
  pinnedByUser: boolean
  tokenEstimate: number
  status: 'available' | 'missing' | 'stale'
  purpose: string
}

export interface ContextBudgetPhasePolicyV1 {
  phaseId: string
  mode: 'auto' | 'fixed'
  selectedBudget: ContextBudgetTierV1
  autoMaxBudget: ContextBudgetTierV1
  /**
   * 临时的抬线（未过期时优先于 `selectedBudget`）。
   *
   * 为什么不直接改 `selectedBudget`：抬线是「让这次撞线先过去」，不是用户想要
   * 一个新档位。写成独立一层，到期自然回落，用户不必记得手动改回来。
   */
  temporaryBudgetOverride?: ContextBudgetTemporaryOverrideV1 | null
  selectionSource: 'agent' | 'host-reconcile' | 'user' | 'default'
  selectionReason: string
  materialRevision: string
  materials: ContextBudgetMaterialRecordV1[]
  consecutiveLowBoundaries: number
  lastBoundaryRevision?: string
  lastAdjustBoundaryId?: string
  lastRequiredInputTokens?: number
  lastCandidateBudget?: ContextBudgetTierV1 | null
  lastCandidateSoftLine?: number | null
}

export interface ContextBudgetSessionPolicyV1 {
  version: 1
  sessionId: string
  activePhaseId: string
  revision: string
  phases: Record<string, ContextBudgetPhasePolicyV1>
  updatedAt: number
}

export interface ContextBudgetSelectionUpdateV1 {
  expectedRevision: string
  mode: 'auto' | 'fixed'
  selectedBudget?: ContextBudgetTierV1
  autoMaxBudget?: ContextBudgetTierV1
}

export interface ContextBudgetMaterialPinUpdateV1 {
  expectedRevision: string
  materialId: string
  pinned: boolean
}

export interface ContextBudgetSelectionUpdateResultV1 {
  ok: boolean
  policy?: ContextBudgetSessionPolicyV1
  error?: string
}

const MIN_ERROR_MARGIN = 2_048
const ERROR_MARGIN_RATIO = 0.02
const MIN_GROWTH = 16_000

/**
 * API-specific output fields observed in the bundled pi 0.87.1 provider
 * builders. Unknown APIs intentionally have no adapter: a similarly named
 * field in an unrelated payload is not evidence of the request's real R.
 */
export const CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1: Readonly<Record<string, ContextBudgetOutputAdapterV1>> = {
  'anthropic-messages': {
    api: 'anthropic-messages', adapterId: 'anthropic-max-tokens-v1',
    fieldPath: ['max_tokens'], accounting: 'provider-max-tokens-includes-thinking-when-configured'
  },
  'openai-completions': {
    api: 'openai-completions', adapterId: 'openai-completions-compat-v1',
    fieldPath: 'openai-completions-compat', accounting: 'provider-max-tokens-field-from-model-compat'
  },
  'openai-responses': {
    api: 'openai-responses', adapterId: 'openai-responses-max-output-tokens-v1',
    fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
  },
  'azure-openai-responses': {
    api: 'azure-openai-responses', adapterId: 'azure-openai-responses-max-output-tokens-v1',
    fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
  },
  'openai-codex-responses': {
    api: 'openai-codex-responses', adapterId: 'openai-codex-responses-max-output-tokens-v1',
    fieldPath: ['max_output_tokens'], accounting: 'responses-max-output-tokens-includes-reasoning'
  },
  'google-generative-ai': {
    api: 'google-generative-ai', adapterId: 'google-generation-config-v1',
    fieldPath: ['generationConfig', 'maxOutputTokens'], accounting: 'google-max-output-tokens-includes-thoughts-when-enabled'
  },
  'google-vertex': {
    api: 'google-vertex', adapterId: 'vertex-generation-config-v1',
    fieldPath: ['generationConfig', 'maxOutputTokens'], accounting: 'google-max-output-tokens-includes-thoughts-when-enabled'
  },
  'bedrock-converse-stream': {
    api: 'bedrock-converse-stream', adapterId: 'bedrock-inference-config-v1',
    fieldPath: ['inferenceConfig', 'maxTokens'], accounting: 'bedrock-inference-max-tokens'
  },
  'mistral-conversations': {
    api: 'mistral-conversations', adapterId: 'mistral-max-tokens-v1',
    fieldPath: ['maxTokens'], accounting: 'mistral-max-tokens-after-payload-normalization'
  }
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Resolve only the final output limit field defined by the selected provider API. */
export function resolveContextBudgetOutputReserveV1(input: {
  api: unknown
  payload: unknown
  compat?: unknown
}): ContextBudgetOutputResolutionV1 {
  if (typeof input.api !== 'string') return { adapterId: 'unknown', outputReserve: null, reason: 'provider_api_unknown' }
  const adapter = CONTEXT_BUDGET_OUTPUT_ADAPTERS_V1[input.api]
  if (!adapter) return { adapterId: 'unsupported', outputReserve: null, reason: 'provider_api_unsupported' }
  let raw: unknown
  if (adapter.fieldPath === 'openai-completions-compat') {
    const compat = input.compat && typeof input.compat === 'object' && !Array.isArray(input.compat)
      ? input.compat as Record<string, unknown>
      : {}
    // Pi's bundled OpenAI Completions adapter defaults to max_completion_tokens
    // when a model compatibility record does not name a field explicitly.
    const field = compat.maxTokensField === undefined ? 'max_completion_tokens' : compat.maxTokensField
    if (field !== 'max_tokens' && field !== 'max_completion_tokens') {
      return { adapterId: adapter.adapterId, outputReserve: null, reason: 'provider_output_field_unknown' }
    }
    raw = valueAtPath(input.payload, [field])
  } else {
    raw = valueAtPath(input.payload, adapter.fieldPath)
  }
  if (!validTokenCount(raw) || raw === 0) {
    return { adapterId: adapter.adapterId, outputReserve: null, reason: 'request_output_limit_unknown' }
  }
  return { adapterId: adapter.adapterId, outputReserve: raw, reason: 'request_output_limit_resolved' }
}

function validTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

export function isContextBudgetTierV1(value: unknown): value is ContextBudgetTierV1 {
  return typeof value === 'number' && (CONTEXT_BUDGET_V1_TIERS as readonly number[]).includes(value)
}

export function normalizeContextBudgetTierV1(value: unknown): ContextBudgetTierV1 | null {
  return isContextBudgetTierV1(value) ? value : null
}

/**
 * 相邻档位 —— 「临时抬软线」与「降档」两个出口共用这一个纯函数。
 *
 * 逐档而不是一步到底：点一次只动一格，用户能看清代价（K 数真的变了）；
 * `ceiling`（自动最高档）是抬线的上限，越过它就不是「临时」而是改配置了。
 * 已经顶到边界时返回原值 —— 调用方据此判断「这一下没有可动的档」。
 */
export function adjacentContextBudgetTierV1(
  current: unknown,
  direction: 'up' | 'down',
  ceiling: unknown = CONTEXT_BUDGET_V1_TIERS[CONTEXT_BUDGET_V1_TIERS.length - 1]
): ContextBudgetTierV1 {
  const tiers = CONTEXT_BUDGET_V1_TIERS
  const normalized = normalizeContextBudgetTierV1(current) ?? tiers[0]
  const cap = normalizeContextBudgetTierV1(ceiling) ?? tiers[tiers.length - 1]
  const index = tiers.indexOf(normalized)
  if (direction === 'up') {
    for (let next = index + 1; next < tiers.length; next++) {
      if (tiers[next] <= cap) return tiers[next]
    }
    return normalized
  }
  return index > 0 ? tiers[index - 1] : normalized
}

/**
 * 「临时抬软线」的有效期。
 *
 * 30 分钟够把手里这轮对话处理完，又不至于让一次手滑变成长期花费 ——
 * 抬线本来就是为了让**这一次**不再撞线，不是要一个新档位。
 */
export const CONTEXT_BUDGET_TEMPORARY_OVERRIDE_MS = 30 * 60 * 1000

export interface ContextBudgetTemporaryOverrideV1 {
  selectedBudget: ContextBudgetTierV1
  expiresAt: number
}

/**
 * 真正生效的软线 —— 宿主（预算门、界面）与扩展必须用同一个数。
 *
 * 分两处算就会出现「界面显示 300K、扩展按 200K 拦」这种无法解释的现象。
 * 过期的覆盖视为不存在（惰性失效，不需要定时任务去清理）。
 */
export function effectiveContextBudgetTierV1(input: {
  selectedBudget: unknown
  temporaryBudgetOverride?: unknown
  now?: number
}): ContextBudgetTierV1 {
  const base = normalizeContextBudgetTierV1(input.selectedBudget) ?? CONTEXT_BUDGET_V1_TIERS[0]
  const override = input.temporaryBudgetOverride
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base
  const item = override as Record<string, unknown>
  const tier = normalizeContextBudgetTierV1(item.selectedBudget)
  const expiresAt = item.expiresAt
  if (!tier || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return base
  const now = typeof input.now === 'number' ? input.now : Date.now()
  if (tier < base) return base
  return expiresAt > now ? tier : base
}

/**
 * Stable, non-secret endpoint identity for one runtime model configuration.
 * Custom endpoint query strings and credentials are intentionally excluded.
 */
export function contextEndpointKeyV1(input: {
  provider: unknown
  api: unknown
  modelId: unknown
  baseUrl?: unknown
}): string | null {
  if (
    typeof input.provider !== 'string' || !input.provider ||
    typeof input.api !== 'string' || !input.api ||
    typeof input.modelId !== 'string' || !input.modelId
  ) return null

  let endpointFingerprint = 'default'
  if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== '') {
    if (typeof input.baseUrl !== 'string') return null
    try {
      const url = new URL(input.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      const publicEndpoint = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
      let first = 0x811c9dc5
      let second = 0x9e3779b9
      for (let index = 0; index < publicEndpoint.length; index++) {
        const code = publicEndpoint.charCodeAt(index)
        first = Math.imul(first ^ code, 0x01000193)
        second = Math.imul(second ^ code, 0x85ebca6b)
      }
      endpointFingerprint = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
    } catch {
      return null
    }
  }
  return `${input.provider}/${input.api}/${input.modelId}/${endpointFingerprint}`
}

/** Read only the bounded, body-free request snapshot written by the final pi hook. */
export function sanitizeContextBudgetRuntimeSnapshotV1(
  raw: unknown,
  sessionId: string,
  now = Date.now()
): ContextBudgetRuntimeSnapshotV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const endpoint = value.endpoint as Record<string, unknown> | undefined
  const check = value.check as Record<string, unknown> | undefined
  const calculation = check?.calculation as Record<string, unknown> | undefined
  const numeric = (item: unknown): number | null =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null
  const decision = check?.decision
  const mode = check?.selectionMode
  if (
    value.version !== 1 || value.stage !== 'final' || value.sessionId !== sessionId ||
    typeof value.requestRevision !== 'string' || !value.requestRevision || value.requestRevision.length > 200 ||
    typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 || value.observedAt > now + 60_000 || now - value.observedAt > 10 * 60_000 ||
    (value.countMode !== 'exact' && value.countMode !== 'estimated' && value.countMode !== 'unavailable') ||
    !endpoint || typeof endpoint.provider !== 'string' || typeof endpoint.modelId !== 'string' ||
    (endpoint.endpointKey !== null && typeof endpoint.endpointKey !== 'string') ||
    !check || (decision !== 'send' && decision !== 'review' && decision !== 'blocked' && decision !== 'unavailable') ||
    typeof check.reason !== 'string' || check.reason.length > 2000 ||
    typeof check.phaseId !== 'string' || check.phaseId.length > 120 ||
    (mode !== 'auto' && mode !== 'fixed') || typeof check.selectionReason !== 'string' ||
    !isContextBudgetTierV1(check.selectedBudget) || !isContextBudgetTierV1(check.autoMaxBudget) ||
    !calculation || typeof calculation.ok !== 'boolean' || typeof calculation.reason !== 'string' ||
    !Number.isSafeInteger(calculation.growth) || !isContextBudgetTierV1(calculation.selectedBudget)
  ) return null
  const optionalLimit = (item: unknown): number | null => item === null ? null : numeric(item)
  const calc: ContextBudgetCalculationV1 = {
    ok: calculation.ok,
    reason: calculation.reason,
    capacityBasis: optionalLimit(calculation.capacityBasis),
    hardInputLimit: optionalLimit(calculation.hardInputLimit),
    errorMargin: optionalLimit(calculation.errorMargin),
    growth: calculation.growth as number,
    selectedBudget: calculation.selectedBudget,
    reviewLine: optionalLimit(calculation.reviewLine),
    targetAfterReview: optionalLimit(calculation.targetAfterReview)
  }
  return {
    version: 1,
    stage: 'final',
    sessionId,
    requestRevision: value.requestRevision,
    observedAt: value.observedAt,
    countMode: value.countMode,
    inputTokens: optionalLimit(value.inputTokens),
    messagesTokens: optionalLimit(value.messagesTokens),
    toolsTokens: optionalLimit(value.toolsTokens),
    systemTokens: optionalLimit(value.systemTokens),
    outputReserve: optionalLimit(value.outputReserve),
    endpoint: {
      provider: endpoint.provider,
      modelId: endpoint.modelId,
      endpointKey: typeof endpoint.endpointKey === 'string' ? endpoint.endpointKey : null
    },
    check: {
      decision,
      reason: check.reason,
      phaseId: check.phaseId,
      selectionMode: mode,
      selectionReason: check.selectionReason,
      selectedBudget: check.selectedBudget,
      autoMaxBudget: check.autoMaxBudget,
      calculation: calc
    }
  }
}

/** Conservative text estimate shared by host-side material planning and extension payload counts. */
export function estimateTextTokensV1(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let wide = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isWide =
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x2e80 && cp <= 0x2fff) ||
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0x3100 && cp <= 0x31bf) ||
      (cp >= 0x3200 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x20000 && cp <= 0x3ffff)
    if (isWide) wide += ch.length
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

export function contextBudgetErrorMarginV1(capacityBasis: number): number {
  if (!validTokenCount(capacityBasis) || capacityBasis === 0) return MIN_ERROR_MARGIN
  return Math.max(MIN_ERROR_MARGIN, Math.ceil(capacityBasis * ERROR_MARGIN_RATIO))
}

/** Compute hard and soft limits from the actual endpoint shape and this request's R. */
export function calculateContextBudgetV1(input: {
  capability: EndpointBudgetCapabilityV1 | null | undefined
  outputReserve: number | null | undefined
  selectedBudget: number
  registeredNextGrowth?: number
}): ContextBudgetCalculationV1 {
  const selectedBudget = isContextBudgetTierV1(input.selectedBudget) ? input.selectedBudget : 200_000
  const rawGrowth = input.registeredNextGrowth ?? 0
  const growth = validTokenCount(rawGrowth) ? Math.max(MIN_GROWTH, rawGrowth) : MIN_GROWTH
  const unavailable = (reason: string, capacityBasis: number | null = null): ContextBudgetCalculationV1 => ({
    ok: false,
    reason,
    capacityBasis,
    hardInputLimit: null,
    errorMargin: null,
    growth,
    selectedBudget,
    reviewLine: null,
    targetAfterReview: null
  })

  const capability = input.capability
  if (!capability) return unavailable('endpoint_capability_unavailable')
  if (!capability.endpointKey || !capability.modelId || !capability.countingAdapter || !capability.revision) {
    return unavailable('endpoint_capability_incomplete')
  }
  if (!validTokenCount(capability.maxOutputTokens) || capability.maxOutputTokens === 0) {
    return unavailable('output_capacity_unknown')
  }
  if (!validTokenCount(input.outputReserve) || input.outputReserve === 0) {
    return unavailable('request_output_limit_unknown')
  }
  if (input.outputReserve > capability.maxOutputTokens) return unavailable('output_limit_invalid')

  let capacityBasis: number
  let hardInputLimit: number
  if (capability.mode === 'shared') {
    if (!validTokenCount(capability.contextWindow) || capability.contextWindow === 0) {
      return unavailable('context_window_unknown')
    }
    const limits = [capability.contextWindow]
    if (capability.maxInputTokens !== undefined) {
      if (!validTokenCount(capability.maxInputTokens) || capability.maxInputTokens === 0) {
        return unavailable('input_limit_invalid')
      }
      limits.push(capability.maxInputTokens)
    }
    capacityBasis = Math.min(...limits)
    hardInputLimit = Math.min(capability.contextWindow - input.outputReserve, ...limits)
  } else if (capability.mode === 'separate') {
    if (!validTokenCount(capability.maxInputTokens) || capability.maxInputTokens === 0) {
      return unavailable('input_limit_unknown')
    }
    capacityBasis = capability.maxInputTokens
    hardInputLimit = capability.maxInputTokens
  } else {
    return unavailable('capacity_mode_unknown')
  }

  const errorMargin = contextBudgetErrorMarginV1(capacityBasis)
  hardInputLimit -= errorMargin
  const reviewLine = Math.min(selectedBudget, hardInputLimit - growth)
  if (hardInputLimit <= 0) return unavailable('hard_input_capacity_exhausted', capacityBasis)
  if (reviewLine <= 0) {
    return {
      ok: false,
      reason: 'review_capacity_exhausted',
      capacityBasis,
      hardInputLimit,
      errorMargin,
      growth,
      selectedBudget,
      reviewLine,
      targetAfterReview: Math.floor(reviewLine * 0.75)
    }
  }

  return {
    ok: true,
    reason: 'budget_available',
    capacityBasis,
    hardInputLimit,
    errorMargin,
    growth,
    selectedBudget,
    reviewLine,
    targetAfterReview: Math.floor(reviewLine * 0.75)
  }
}

/** Select the smallest legal tier from verified required material, never from stale history size. */
export function selectAutoContextBudgetV1(input: AutoBudgetSelectionInputV1): AutoBudgetSelectionV1 {
  const current = normalizeContextBudgetTierV1(input.currentBudget) ?? 200_000
  const max = normalizeContextBudgetTierV1(input.autoMaxBudget) ?? 700_000
  const calculation = calculateContextBudgetV1({
    capability: input.capability,
    outputReserve: input.outputReserve,
    selectedBudget: max,
    registeredNextGrowth: input.registeredNextGrowth
  })
  const noCandidate = (reason: string): AutoBudgetSelectionV1 => ({
    ok: false,
    selectedBudget: current,
    candidateBudget: null,
    reason,
    changed: false,
    deferredDownshift: false,
    calculation
  })
  if (!validTokenCount(input.requiredInputTokens)) return noCandidate('required_input_count_unavailable')
  if (!calculation.hardInputLimit || calculation.hardInputLimit <= 0) return noCandidate(calculation.reason)

  const capacityAfterGrowth = calculation.hardInputLimit - calculation.growth
  if (input.requiredInputTokens >= capacityAfterGrowth) return noCandidate('required_materials_exceed_endpoint_capacity')

  const legalTiers = CONTEXT_BUDGET_V1_TIERS.filter((tier) => tier <= max)
  const candidate = legalTiers.find((tier) => input.requiredInputTokens < Math.min(tier, capacityAfterGrowth))
  if (!candidate) return noCandidate('no_tier_fits_required_materials')

  if (candidate >= current) {
    return {
      ok: true,
      selectedBudget: candidate,
      candidateBudget: candidate,
      reason: candidate > current ? 'required_materials_need_larger_tier' : input.phaseChanged ? 'new_phase_minimum_tier' : 'current_tier_is_minimum_sufficient',
      changed: candidate !== current,
      deferredDownshift: false,
      calculation: calculateContextBudgetV1({
        capability: input.capability,
        outputReserve: input.outputReserve,
        selectedBudget: candidate,
        registeredNextGrowth: input.registeredNextGrowth
      })
    }
  }

  const candidateSoftLine = Math.min(candidate, capacityAfterGrowth)
  const lowEnough = input.requiredInputTokens <= Math.floor(candidateSoftLine * 0.8)
  const canProject = input.losslessProjectionFitsCandidate === true
  const boundaries = Number.isSafeInteger(input.consecutiveLowBoundaries)
    ? Math.max(0, input.consecutiveLowBoundaries as number)
    : 0
  if (input.phaseChanged) {
    if (!canProject) {
      return {
        ok: true,
        selectedBudget: current,
        candidateBudget: candidate,
        reason: 'phase_changed_waiting_for_lossless_projection',
        changed: false,
        deferredDownshift: true,
        calculation: calculateContextBudgetV1({
          capability: input.capability,
          outputReserve: input.outputReserve,
          selectedBudget: current,
          registeredNextGrowth: input.registeredNextGrowth
        })
      }
    }
    return {
      ok: true,
      selectedBudget: candidate,
      candidateBudget: candidate,
      reason: 'phase_changed_minimum_tier_after_lossless_projection',
      changed: candidate !== current,
      deferredDownshift: false,
      calculation: calculateContextBudgetV1({
        capability: input.capability,
        outputReserve: input.outputReserve,
        selectedBudget: candidate,
        registeredNextGrowth: input.registeredNextGrowth
      })
    }
  }
  if (!lowEnough || !canProject || boundaries < 2) {
    return {
      ok: true,
      selectedBudget: current,
      candidateBudget: candidate,
      reason: !lowEnough ? 'downshift_hysteresis_not_met' : !canProject ? 'lossless_projection_not_ready' : 'awaiting_second_low_boundary',
      changed: false,
      deferredDownshift: true,
      calculation: calculateContextBudgetV1({
        capability: input.capability,
        outputReserve: input.outputReserve,
        selectedBudget: current,
        registeredNextGrowth: input.registeredNextGrowth
      })
    }
  }

  return {
    ok: true,
    selectedBudget: candidate,
    candidateBudget: candidate,
    reason: 'downshift_after_two_low_boundaries',
    changed: candidate !== current,
    deferredDownshift: false,
    calculation: calculateContextBudgetV1({
      capability: input.capability,
      outputReserve: input.outputReserve,
      selectedBudget: candidate,
      registeredNextGrowth: input.registeredNextGrowth
    })
  }
}

/**
 * 宿主按**实际发出的请求规模**回收档位（需求稿 8.3）。
 *
 * 上面的 selectAutoContextBudgetV1 只在 agent 主动 `yan context budget adjust` 时评估；
 * 整理完成后实际输入已经变小，但 agent 不调整时高档位会一直留着。这里在每个回合结束时，
 * 用这一回合最后一次真实请求的输入量判断：
 *   · 找比当前低、且实际输入不超过其软线 60% 的最小档位（留出下一回合的增长空间）；
 *   · 连续两个回合都满足才降，每次只降到这个候选档；达不到就把计数清零；
 *   · 只降不升 —— 升档仍由材料登记（adjust）与请求门禁负责。
 */
export const CONTEXT_BUDGET_HOST_DOWNSHIFT_RATIO = 0.6
export const CONTEXT_BUDGET_HOST_DOWNSHIFT_TURNS = 2

export interface ObservedBudgetReconcileV1 {
  /** 这个回合是否「用量低」（存在更低的合适档位） */
  lowTurn: boolean
  /** 本回合后的连续低用量回合数 */
  lowTurns: number
  candidateBudget: ContextBudgetTierV1 | null
  /** 需要把档位降到 candidateBudget */
  apply: boolean
  reason: string
}

export function reconcileObservedContextBudgetV1(input: {
  observedInputTokens: number | null | undefined
  capability: EndpointBudgetCapabilityV1 | null | undefined
  outputReserve: number | null | undefined
  currentBudget: number
  previousLowTurns: number
}): ObservedBudgetReconcileV1 {
  const current = normalizeContextBudgetTierV1(input.currentBudget)
  const none = (reason: string): ObservedBudgetReconcileV1 => ({ lowTurn: false, lowTurns: 0, candidateBudget: null, apply: false, reason })
  if (!current) return none('current_budget_invalid')
  if (!validTokenCount(input.observedInputTokens)) return none('observed_input_unavailable')
  const observed = input.observedInputTokens as number
  let candidate: ContextBudgetTierV1 | null = null
  for (const tier of CONTEXT_BUDGET_V1_TIERS) {
    if (tier >= current) break
    const calculation = calculateContextBudgetV1({ capability: input.capability, outputReserve: input.outputReserve, selectedBudget: tier })
    if (!calculation.ok || calculation.reviewLine === null) continue
    if (observed <= Math.floor(calculation.reviewLine * CONTEXT_BUDGET_HOST_DOWNSHIFT_RATIO)) {
      candidate = tier
      break
    }
  }
  if (!candidate) return none(current === CONTEXT_BUDGET_V1_TIERS[0] ? 'already_minimum_tier' : 'observed_input_not_low_enough')
  const previous = Number.isSafeInteger(input.previousLowTurns) ? Math.max(0, input.previousLowTurns) : 0
  const lowTurns = Math.min(CONTEXT_BUDGET_HOST_DOWNSHIFT_TURNS, previous + 1)
  const apply = lowTurns >= CONTEXT_BUDGET_HOST_DOWNSHIFT_TURNS
  return {
    lowTurn: true,
    lowTurns,
    candidateBudget: candidate,
    apply,
    reason: apply ? 'host_downshift_after_low_turns' : 'awaiting_next_low_turn'
  }
}

/** Classify a prepared/final payload. Unknown counts or output settings fail closed. */
export function checkContextBudgetRequestV1(input: ContextBudgetRequestCheckInputV1): ContextBudgetRequestCheckV1 {
  const calculation = calculateContextBudgetV1({
    capability: input.capability,
    outputReserve: input.outputReserve,
    selectedBudget: input.selectedBudget,
    registeredNextGrowth: input.registeredNextGrowth
  })
  if (!calculation.ok) return { decision: 'unavailable', reason: calculation.reason, calculation }
  if (input.countMode === 'unavailable' || !validTokenCount(input.inputTokens)) {
    return { decision: 'unavailable', reason: 'request_input_count_unavailable', calculation }
  }
  if (input.inputTokens > (calculation.hardInputLimit as number)) {
    return { decision: 'blocked', reason: 'hard_input_limit_exceeded', calculation }
  }
  if (input.inputTokens >= (calculation.reviewLine as number)) {
    return { decision: input.countMode === 'exact' ? 'review' : 'review', reason: 'soft_review_line_reached', calculation }
  }
  return { decision: 'send', reason: 'within_review_line', calculation }
}
