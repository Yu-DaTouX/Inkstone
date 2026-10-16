import type {
  ContextBudget,
  ContextNextStage,
  ContextOperationKind,
  ContextPolicy,
  ContextPolicyOverrides,
  ContextPolicySource
} from './ipc'

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  enabled: true,
  workingSetCap: 240_000,
  windowRatio: 0.7,
  responseReservePreferred: 32_000,
  responseReserveMin: 16_000,
  safetyMarginMin: 8_000,
  safetyMarginRatio: 0.02,
  emergencyRatio: 0.9,
  triggerRatios: { sweep: 0.7, fold: 0.85, compact: 1 },
  kinds: ['tool-sweep', 'recall', 'episode-fold', 'compaction']
}

const ALL_KINDS: readonly ContextOperationKind[] = [
  'tool-sweep',
  'episode-fold',
  'compaction',
  'recall'
]

export const CONTEXT_POLICY_PRESETS: Record<'default' | 'reference', ContextPolicyOverrides> = {
  default: {},
  reference: { workingSetCap: 300_000, windowRatio: 0.75 }
}

export const LARGE_CONTEXT_POLICY_PRESETS: Record<'balanced' | 'long', ContextPolicyOverrides> = {
  balanced: { workingSetCap: 600_000, windowRatio: 0.7 },
  long: { workingSetCap: 700_000, windowRatio: 0.7 }
}

function effectiveOverrides(overrides: ContextPolicyOverrides): Record<string, unknown> {
  const base = DEFAULT_CONTEXT_POLICY as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue
    if (base[key] === value) continue
    out[key] = value
  }
  return out
}

export function largePresetOf(overrides?: ContextPolicyOverrides): 'balanced' | 'long' | undefined {
  if (!overrides) return undefined
  const mine = effectiveOverrides(overrides)
  for (const preset of ['balanced', 'long'] as const) {
    const target = effectiveOverrides(LARGE_CONTEXT_POLICY_PRESETS[preset])
    const keys = new Set([...Object.keys(mine), ...Object.keys(target)])
    let same = true
    for (const key of keys) {
      if (mine[key] !== target[key]) {
        same = false
        break
      }
    }
    if (same) return preset
  }
  return undefined
}

export const LARGE_PRESET_NAME_KEYS: Record<'balanced' | 'long', string> = {
  balanced: 'set.ctxModelPresetBalanced',
  long: 'set.ctxModelPresetLong'
}

export function contextBudget(
  contextWindow: number,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY
): ContextBudget | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null
  const win = Math.round(contextWindow)

  const responseReserve = Math.max(
    policy.responseReserveMin,
    Math.min(policy.responseReservePreferred, Math.round(win * 0.25))
  )
  const safetyMargin = Math.max(policy.safetyMarginMin, Math.round(win * policy.safetyMarginRatio))
  const workingSet = Math.min(
    policy.workingSetCap,
    Math.round(win * policy.windowRatio),
    win - responseReserve - safetyMargin
  )
  if (workingSet <= 0) return null

  const ratio = policy.triggerRatios
  return {
    contextWindow: win,
    responseReserve,
    safetyMargin,
    workingSet,
    triggers: {
      sweep: Math.round(workingSet * ratio.sweep),
      fold: Math.round(workingSet * ratio.fold),
      compact: Math.round(workingSet * ratio.compact)
    },
    emergency: Math.min(Math.round(win * policy.emergencyRatio), win - responseReserve)
  }
}

function num(v: unknown, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < min || v > max) return null
  return v
}

export function applyOverrides(
  policy: ContextPolicy,
  raw: ContextPolicyOverrides | undefined | null
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const o = raw as Record<string, unknown>
  const applied: string[] = []

  const cap = num(o.workingSetCap, { min: 1 })
  if (cap !== null) {
    policy.workingSetCap = Math.round(cap)
    applied.push('workingSetCap')
  }
  const winRatio = num(o.windowRatio, { min: 0.05, max: 1 })
  if (winRatio !== null) {
    policy.windowRatio = winRatio
    applied.push('windowRatio')
  }
  const preferred = num(o.responseReservePreferred)
  if (preferred !== null) {
    policy.responseReservePreferred = Math.round(preferred)
    applied.push('responseReservePreferred')
  }
  const reserveMin = num(o.responseReserveMin)
  if (reserveMin !== null) {
    policy.responseReserveMin = Math.round(reserveMin)
    applied.push('responseReserveMin')
  }
  const marginMin = num(o.safetyMarginMin)
  if (marginMin !== null) {
    policy.safetyMarginMin = Math.round(marginMin)
    applied.push('safetyMarginMin')
  }
  const marginRatio = num(o.safetyMarginRatio, { max: 1 })
  if (marginRatio !== null) {
    policy.safetyMarginRatio = marginRatio
    applied.push('safetyMarginRatio')
  }
  const emergency = num(o.emergencyRatio, { min: 0.0001, max: 1 })
  if (emergency !== null) {
    policy.emergencyRatio = emergency
    applied.push('emergencyRatio')
  }

  const ratios = o.triggerRatios
  if (ratios && typeof ratios === 'object' && !Array.isArray(ratios)) {
    const r = ratios as Record<string, unknown>
    for (const key of ['sweep', 'fold', 'compact'] as const) {
      const v = num(r[key], { min: 0.01, max: 1 })
      if (v !== null) {
        policy.triggerRatios[key] = v
        applied.push(`triggerRatios.${key}`)
      }
    }
  }
  return applied
}

export function policyFrom(
  raw: string | undefined | null,
  base: ContextPolicy = DEFAULT_CONTEXT_POLICY
): ContextPolicy {
  if (!raw || !raw.trim()) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const o = parsed as Record<string, unknown>
  const out: ContextPolicy = { ...base, triggerRatios: { ...base.triggerRatios } }

  applyOverrides(out, o as ContextPolicyOverrides)
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled

  const kinds = o.kinds
  if (Array.isArray(kinds)) {
    const picked = kinds.filter(
      (k): k is ContextOperationKind => typeof k === 'string' && (ALL_KINDS as readonly string[]).includes(k)
    )
    if (picked.length || kinds.length === 0) out.kinds = picked
  }
  return out
}

export interface ContextPolicyLayer {
  source: ContextPolicySource
  key?: string
  overrides: ContextPolicyOverrides
}

export interface ResolvedContextPolicy {
  policy: ContextPolicy
  source: ContextPolicySource
  sourceKey?: string
  overridden: string[]
}

export interface ContextPolicyLayers {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  modelKey?: string
  provider?: string
  envRaw?: string
  foldEnabled?: boolean
}

function diffPolicy(a: ContextPolicy, b: ContextPolicy): string[] {
  const out: string[] = []
  const flat = [
    'enabled',
    'workingSetCap',
    'windowRatio',
    'responseReservePreferred',
    'responseReserveMin',
    'safetyMarginMin',
    'safetyMarginRatio',
    'emergencyRatio'
  ] as const
  for (const key of flat) if (a[key] !== b[key]) out.push(key)
  for (const key of ['sweep', 'fold', 'compact'] as const) {
    if (a.triggerRatios[key] !== b.triggerRatios[key]) out.push(`triggerRatios.${key}`)
  }
  if (JSON.stringify(a.kinds) !== JSON.stringify(b.kinds)) out.push('kinds')
  return out
}

export function resolveContextPolicy(layers: ContextPolicyLayers = {}): ResolvedContextPolicy {
  const policy: ContextPolicy = {
    ...DEFAULT_CONTEXT_POLICY,
    triggerRatios: { ...DEFAULT_CONTEXT_POLICY.triggerRatios },
    kinds: [...DEFAULT_CONTEXT_POLICY.kinds]
  }
  let source: ContextPolicySource = 'default'
  let sourceKey: string | undefined
  const overridden: string[] = []

  const apply = (
    raw: ContextPolicyOverrides | undefined,
    src: ContextPolicySource,
    key?: string
  ): void => {
    const applied = applyOverrides(policy, raw)
    if (!applied.length) return
    source = src
    sourceKey = key
    for (const f of applied) if (!overridden.includes(f)) overridden.push(f)
  }

  apply(layers.user, 'user')
  if (layers.foldEnabled === false && policy.kinds.includes('episode-fold')) {
    policy.kinds = policy.kinds.filter((k) => k !== 'episode-fold')
    source = 'user'
    sourceKey = undefined
    if (!overridden.includes('kinds')) overridden.push('kinds')
  }
  const provider = layers.provider ?? (layers.modelKey ? layers.modelKey.split('/')[0] : undefined)
  if (provider) apply(layers.byModel?.[provider], 'provider', provider)
  if (layers.modelKey) apply(layers.byModel?.[layers.modelKey], 'model', layers.modelKey)

  const envRaw = layers.envRaw
  if (envRaw && envRaw.trim()) {
    const withEnv = policyFrom(envRaw, policy)
    const diff = diffPolicy(policy, withEnv)
    if (diff.length) {
      Object.assign(policy, withEnv)
      source = 'env'
      sourceKey = undefined
      for (const f of diff) if (!overridden.includes(f)) overridden.push(f)
    }
  }

  return { policy, source, sourceKey, overridden }
}

export function hasExplicitLegacyOverride(resolved: ResolvedContextPolicy): boolean {
  return resolved.source !== 'default' && resolved.overridden.some((field) => field !== 'kinds')
}

export const POLICY_COOLDOWN_MS = 30_000
export const POLICY_REARM_RATIO = 0.9
export const POLICY_RESET_RATIO = 0.8
export const POLICY_GROWTH_MIN_TOKENS = 16_000
export const POLICY_GROWTH_RATIO = 0.05
export const POLICY_REARM_MS = 5 * 60_000

export function rearmAfterCompaction(
  state: ContextPolicyState,
  tokensAfter?: number | null
): ContextPolicyState {
  const mark = Number.isFinite(tokensAfter) && (tokensAfter as number) > 0 ? Math.round(tokensAfter as number) : null
  if (state.armed && state.tokensAfterCompaction === mark) return state
  return { ...state, armed: true, tokensAfterCompaction: mark }
}

export function policyGrowthMinTokens(budget: ContextBudget | null): number {
  if (!budget) return 0
  const line = budget.triggers.compact
  if (line <= 0) return 0
  return Math.min(line, Math.max(POLICY_GROWTH_MIN_TOKENS, Math.round(line * POLICY_GROWTH_RATIO)))
}

export function incompressibleBaselineNotice(
  tokens: number | null,
  budget: ContextBudget | null,
  afterTokens: number | null | undefined
): boolean {
  if (!budget || tokens === null || !Number.isFinite(tokens)) return false
  if (typeof afterTokens !== 'number' || !Number.isFinite(afterTokens) || afterTokens <= 0) return false
  const line = budget.triggers.compact
  if (line <= 0) return false
  if (afterTokens < line * POLICY_RESET_RATIO) return false
  return tokens < line + policyGrowthMinTokens(budget)
}

export interface ContextPolicyState {
  armed: boolean
  lastTriggerAt: number | null
  tokensAfterCompaction?: number | null
}

export const INITIAL_POLICY_STATE: ContextPolicyState = { armed: true, lastTriggerAt: null }

export type ContextTrigger = 'compact' | 'emergency'

export interface PolicyStepInput {
  state: ContextPolicyState
  tokens: number | null
  budget: ContextBudget | null
  policy: ContextPolicy
  busy: boolean
  now?: number
  cooldownMs?: number
}

export interface PolicyStepResult {
  state: ContextPolicyState
  trigger: ContextTrigger | null
}

export function contextPolicyStep(input: PolicyStepInput): PolicyStepResult {
  const { policy, budget, tokens, busy } = input
  const now = input.now ?? Date.now()
  const cooldown = input.cooldownMs ?? POLICY_COOLDOWN_MS
  const state = input.state

  if (!policy.enabled || tokens === null || !Number.isFinite(tokens) || !budget) {
    return { state, trigger: null }
  }

  const retryReached = state.lastTriggerAt !== null && now - state.lastTriggerAt >= POLICY_REARM_MS
  const armed =
    state.armed || tokens < budget.triggers.compact * POLICY_REARM_RATIO || retryReached

  const growthMin = policyGrowthMinTokens(budget)
  const after = state.tokensAfterCompaction
  const settled =
    after === null ||
    after === undefined ||
    tokens < budget.triggers.compact * POLICY_RESET_RATIO ||
    tokens - after >= growthMin ||
    retryReached

  const rearmed: ContextPolicyState = { ...state, armed }

  const crossed: ContextTrigger | null =
    tokens >= budget.emergency ? 'emergency' : tokens >= budget.triggers.compact ? 'compact' : null
  if (!crossed) return { state: rearmed, trigger: null }

  if (crossed === 'compact' && (!armed || !settled)) return { state: rearmed, trigger: null }
  if (busy) return { state: rearmed, trigger: null }
  if (state.lastTriggerAt !== null && now - state.lastTriggerAt < cooldown) {
    return { state: rearmed, trigger: null }
  }

  return { state: { armed: false, lastTriggerAt: now }, trigger: crossed }
}

export function nextContextStage(
  tokens: number | null,
  budget: ContextBudget | null,
  kinds: readonly ContextOperationKind[]
): ContextNextStage | null {
  if (!budget) return null
  const used = tokens === null || !Number.isFinite(tokens) ? 0 : tokens
  const candidates: ContextNextStage[] = []
  if (kinds.includes('tool-sweep')) {
    candidates.push({ kind: 'tool-sweep', at: budget.triggers.sweep, reached: false })
  }
  if (kinds.includes('episode-fold')) {
    candidates.push({ kind: 'episode-fold', at: budget.triggers.fold, reached: false })
  }
  if (kinds.includes('compaction')) {
    candidates.push({ kind: 'compaction', at: budget.triggers.compact, reached: false })
  }
  if (!candidates.length) return null

  candidates.sort((a, b) => a.at - b.at)
  const ahead = candidates.find((c) => c.at > used)
  if (ahead) return ahead
  const last = candidates[candidates.length - 1]
  return { ...last, reached: true }
}

function overridesFromPolicy(p: ContextPolicy): ContextPolicyOverrides {
  const d = DEFAULT_CONTEXT_POLICY
  const out: ContextPolicyOverrides = {}
  if (p.workingSetCap !== d.workingSetCap) out.workingSetCap = p.workingSetCap
  if (p.windowRatio !== d.windowRatio) out.windowRatio = p.windowRatio
  if (p.responseReservePreferred !== d.responseReservePreferred) {
    out.responseReservePreferred = p.responseReservePreferred
  }
  if (p.responseReserveMin !== d.responseReserveMin) out.responseReserveMin = p.responseReserveMin
  if (p.safetyMarginMin !== d.safetyMarginMin) out.safetyMarginMin = p.safetyMarginMin
  if (p.safetyMarginRatio !== d.safetyMarginRatio) out.safetyMarginRatio = p.safetyMarginRatio
  if (p.emergencyRatio !== d.emergencyRatio) out.emergencyRatio = p.emergencyRatio
  const ratios: { sweep?: number; fold?: number; compact?: number } = {}
  for (const key of ['sweep', 'fold', 'compact'] as const) {
    if (p.triggerRatios[key] !== d.triggerRatios[key]) ratios[key] = p.triggerRatios[key]
  }
  if (Object.keys(ratios).length) out.triggerRatios = ratios
  return out
}

export function sanitizeContextPolicyOverrides(v: unknown): ContextPolicyOverrides | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const probe: ContextPolicy = {
    ...DEFAULT_CONTEXT_POLICY,
    triggerRatios: { ...DEFAULT_CONTEXT_POLICY.triggerRatios },
    kinds: [...DEFAULT_CONTEXT_POLICY.kinds]
  }
  if (!applyOverrides(probe, v as ContextPolicyOverrides).length) return undefined
  const clean = overridesFromPolicy(probe)
  return Object.keys(clean).length ? clean : undefined
}

export function sanitizeContextPolicyByModel(
  v: unknown
): Record<string, ContextPolicyOverrides> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, ContextPolicyOverrides> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const trimmed = key.trim()
    if (!trimmed || trimmed.length > 200) continue
    const clean = sanitizeContextPolicyOverrides(value)
    if (clean) out[trimmed] = clean
  }
  return Object.keys(out).length ? out : undefined
}

export interface EffectiveContextPolicyDocument {
  v: 1
  revision: string
  updatedAt: number
  default: ContextPolicyOverrides
  byModel: Record<string, ContextPolicyOverrides>
  foldEnabled: boolean
}

function canonicalOverrides(o: ContextPolicyOverrides | undefined): string {
  if (!o) return '{}'
  const keys = Object.keys(o).sort() as Array<keyof ContextPolicyOverrides>
  return JSON.stringify(keys.map((k) => [k, o[k]]))
}

export function contextPolicyRevision(input: {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  foldEnabled?: boolean
}): string {
  const byModel = input.byModel ?? {}
  const modelPart = Object.keys(byModel)
    .sort()
    .map((k) => `${k}=${canonicalOverrides(byModel[k])}`)
    .join(';')
  const canonical = `u:${canonicalOverrides(input.user)}|m:${modelPart}|f:${input.foldEnabled === false ? 0 : 1}`
  let hash = 5381
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

export function buildEffectivePolicyDocument(input: {
  user?: ContextPolicyOverrides
  byModel?: Record<string, ContextPolicyOverrides>
  foldEnabled?: boolean
  now?: number
}): EffectiveContextPolicyDocument {
  return {
    v: 1,
    revision: contextPolicyRevision(input),
    updatedAt: input.now ?? Date.now(),
    default: { ...(input.user ?? {}) },
    byModel: { ...(input.byModel ?? {}) },
    foldEnabled: input.foldEnabled !== false
  }
}

export function overridesOfEffectiveDocument(
  doc: unknown,
  modelKey: string | undefined
): ContextPolicyOverrides {
  if (!doc || typeof doc !== 'object') return {}
  const item = doc as Partial<EffectiveContextPolicyDocument>
  if (item.v !== 1) return {}
  const byModel = item.byModel && typeof item.byModel === 'object' ? item.byModel : {}
  const provider = modelKey && modelKey.includes('/') ? modelKey.split('/')[0] : ''
  return {
    ...(sanitizeContextPolicyOverrides(item.default) ?? {}),
    ...(provider && Object.hasOwn(byModel, provider) ? sanitizeContextPolicyOverrides(byModel[provider]) ?? {} : {}),
    ...(modelKey && Object.hasOwn(byModel, modelKey) ? sanitizeContextPolicyOverrides(byModel[modelKey]) ?? {} : {})
  }
}
