export const PI_API_IDS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'azure-openai-responses',
  'mistral-conversations',
  'bedrock-converse-stream',
  'openai-codex-responses',
  'openrouter-images',
  'pi-messages'
] as const

export const CUSTOM_API_CHOICES = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Generative AI' },
  { id: 'mistral-conversations', label: 'Mistral Conversations' }
] as const

export type CustomApiId = (typeof CUSTOM_API_CHOICES)[number]['id']

export interface CustomProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  api?: CustomApiId
  baseUrl?: string
  thinkingLevelMap?: Record<string, string | null>
  cost?: ModelCost
}

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function cleanModelCost(value: unknown): ModelCost | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const cost = { input: num(raw.input), output: num(raw.output), cacheRead: num(raw.cacheRead), cacheWrite: num(raw.cacheWrite) }
  return cost.input > 0 || cost.output > 0 ? cost : undefined
}

const THINKING_LEVEL_KEYS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function cleanThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string | null> = {}
  for (const key of THINKING_LEVEL_KEYS) {
    const v = (value as Record<string, unknown>)[key]
    if (v === null || (typeof v === 'string' && v.trim() && !hasExecutablePrefix(v))) out[key] = v
  }
  return Object.keys(out).length ? out : undefined
}

function isCustomApiId(value: unknown): value is CustomApiId {
  return CUSTOM_API_CHOICES.some((choice) => choice.id === value)
}

export interface CustomProviderView {
  id: string
  api: string
  baseUrl: string
  models: CustomProviderModel[]
  hasApiKey: boolean
}

export interface CustomProviderInput {
  id: string
  api: string
  baseUrl: string
  models: CustomProviderModel[]
  apiKey?: string
}

export const CUSTOM_PROVIDER_PREFIX = 'yan-'

export function isYanProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^yan-[a-z0-9][a-z0-9-]*$/.test(value)
}

export function hasExecutablePrefix(value: string): boolean {
  return value.trimStart().startsWith('!')
}

export function validateBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Base URL 不能为空'
  const raw = value.trim()
  if (hasExecutablePrefix(raw)) return 'Base URL 不能以 ! 开头（可执行字符串不允许写盘）'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Base URL 不是合法地址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Base URL 只支持 http / https'
  return null
}

export interface ValidateResult {
  ok: boolean
  errors: string[]
  value?: CustomProviderInput
}

export function validateCustomProvider(input: Partial<CustomProviderInput>): ValidateResult {
  const errors: string[] = []
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!isYanProviderId(id)) {
    errors.push(`Provider ID 必须形如 ${CUSTOM_PROVIDER_PREFIX}xxx（小写字母、数字、连字符）`)
  }
  const api = typeof input.api === 'string' ? input.api : ''
  if (!CUSTOM_API_CHOICES.some((choice) => choice.id === api)) {
    errors.push('请选择一个受支持的协议')
  }
  const urlError = validateBaseUrl(input.baseUrl)
  if (urlError) errors.push(urlError)

  const models = Array.isArray(input.models) ? input.models : []
  const cleaned: CustomProviderModel[] = []
  const seen = new Set<string>()
  for (const raw of models) {
    const modelId = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (!modelId) {
      errors.push('模型 ID 不能为空')
      continue
    }
    if (hasExecutablePrefix(modelId)) {
      errors.push(`模型 ID「${modelId}」不能以 ! 开头`)
      continue
    }
    if (seen.has(modelId)) {
      errors.push(`模型 ID 重复：${modelId}`)
      continue
    }
    seen.add(modelId)
    const next: CustomProviderModel = { id: modelId }
    if (typeof raw.name === 'string' && raw.name.trim()) next.name = raw.name.trim()
    for (const key of ['contextWindow', 'maxTokens'] as const) {
      const value = raw[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) next[key] = Math.round(value)
    }
    if (raw.reasoning === true) next.reasoning = true
    if (Array.isArray(raw.input)) {
      const kinds = raw.input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image')
      if (kinds.length) next.input = [...new Set(kinds)]
    }
    if (raw.api !== undefined) {
      if (isCustomApiId(raw.api)) next.api = raw.api
      else errors.push(`模型「${modelId}」的协议不受支持`)
    }
    if (raw.baseUrl !== undefined) {
      const modelUrlError = validateBaseUrl(raw.baseUrl)
      if (modelUrlError) errors.push(`模型「${modelId}」：${modelUrlError}`)
      else next.baseUrl = String(raw.baseUrl).trim()
    }
    if (next.reasoning) {
      const map = cleanThinkingLevelMap(raw.thinkingLevelMap)
      if (map) next.thinkingLevelMap = map
    }
    const cost = cleanModelCost(raw.cost)
    if (cost) next.cost = cost
    cleaned.push(next)
  }
  if (!cleaned.length) errors.push('至少要有一个模型')
  if (typeof input.apiKey === 'string' && hasExecutablePrefix(input.apiKey)) {
    errors.push('API Key 不能是 ! 开头的可执行字符串')
  }

  if (errors.length) return { ok: false, errors }
  const value: CustomProviderInput = { id, api, baseUrl: String(input.baseUrl).trim(), models: cleaned }
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) value.apiKey = input.apiKey.trim()
  return { ok: true, errors: [], value }
}

type Json = Record<string, unknown>

export function readCustomProviders(modelsJson: unknown): CustomProviderView[] {
  const providers = (modelsJson as Json | undefined)?.providers
  if (!providers || typeof providers !== 'object') return []
  const out: CustomProviderView[] = []
  for (const [id, raw] of Object.entries(providers as Json)) {
    if (!isYanProviderId(id)) continue
    const entry = (raw ?? {}) as Json
    const models = Array.isArray(entry.models) ? entry.models : []
    out.push({
      id,
      api: typeof entry.api === 'string' ? entry.api : '',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      models: models
        .filter((m): m is Json => !!m && typeof m === 'object')
        .map((m) => {
          const model: CustomProviderModel = { id: typeof m.id === 'string' ? m.id : '' }
          if (typeof m.name === 'string') model.name = m.name
          if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
          if (typeof m.maxTokens === 'number') model.maxTokens = m.maxTokens
          if (m.reasoning === true) model.reasoning = true
          if (Array.isArray(m.input)) {
            model.input = m.input.filter((k): k is 'text' | 'image' => k === 'text' || k === 'image')
          }
          if (isCustomApiId(m.api)) model.api = m.api
          if (typeof m.baseUrl === 'string' && m.baseUrl) model.baseUrl = m.baseUrl
          const map = m.reasoning === true ? cleanThinkingLevelMap(m.thinkingLevelMap) : undefined
          if (map) model.thinkingLevelMap = map
          const cost = cleanModelCost(m.cost)
          if (cost) model.cost = cost
          return model
        })
        .filter((m) => m.id),
      hasApiKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function mergeCustomProviders(
  modelsJson: unknown,
  updates: CustomProviderInput[],
  removals: string[] = []
): { next: Json; changed: boolean } {
  const base: Json = modelsJson && typeof modelsJson === 'object' ? { ...(modelsJson as Json) } : {}
  const providers: Json = base.providers && typeof base.providers === 'object' ? { ...(base.providers as Json) } : {}
  let changed = false

  for (const id of removals) {
    if (!isYanProviderId(id)) continue
    if (id in providers) {
      delete providers[id]
      changed = true
    }
  }

  for (const update of updates) {
    if (!isYanProviderId(update.id)) continue
    const previous = (providers[update.id] ?? {}) as Json
    const entry: Json = { ...previous, api: update.api, baseUrl: update.baseUrl }
    const previousModels = Array.isArray(previous.models) ? (previous.models as unknown[]).filter((m): m is Json => !!m && typeof m === 'object') : []
    entry.models = update.models.map((model) => {
      const prior = previousModels.find((item) => item.id === model.id)
      return prior ? { ...prior, ...model } : model
    })
    if (update.apiKey) entry.apiKey = update.apiKey
    else if (typeof previous.apiKey === 'string') entry.apiKey = previous.apiKey
    providers[update.id] = entry
    changed = true
  }

  if (!changed) return { next: base, changed: false }
  base.providers = providers
  return { next: base, changed: true }
}

export function maskCustomProvider(view: CustomProviderView): CustomProviderView & { apiKeyLabel: string } {
  return { ...view, apiKeyLabel: view.hasApiKey ? '••••••' : '' }
}

export type CustomProviderTestMode = 'endpoint' | 'billable'

export interface CustomProviderTestResult {
  ok: boolean
  mode: CustomProviderTestMode
  ms: number
  message: string
  text?: string
}

export function parseModelList(json: unknown): string[] {
  return parseModelEntries(json).map((model) => model.id)
}

export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  endpoints?: string[]
  reasoning?: boolean
  image?: boolean
}

export function parseModelEntries(json: unknown): DiscoveredModel[] {
  const root = json as { data?: unknown; models?: unknown } | unknown[] | null
  const list = Array.isArray(root) ? root : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : []
  const out: DiscoveredModel[] = []
  for (const item of list) {
    const entry = item as Record<string, unknown> | string
    if (typeof entry === 'object' && entry && Array.isArray(entry.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes('generateContent')) continue
    const raw = typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : ''
    const id = raw.replace(/^models\//, '').trim()
    if (!id || hasExecutablePrefix(id) || out.some((m) => m.id === id)) continue
    const model: DiscoveredModel = { id }
    if (typeof entry === 'object' && entry) {
      if (typeof entry.name === 'string' && entry.name.trim() && entry.name !== raw) model.name = entry.name.trim()
      if (typeof entry.display_name === 'string' && entry.display_name.trim()) model.name = entry.display_name.trim()
      const context = [entry.context_length, entry.context_window, entry.inputTokenLimit].find((v) => typeof v === 'number' && v > 0)
      if (typeof context === 'number') model.contextWindow = Math.round(context)
      if (Array.isArray(entry.supported_endpoints)) model.endpoints = entry.supported_endpoints.filter((p): p is string => typeof p === 'string')
      if (Array.isArray(entry.supported_parameters)) {
        const params = entry.supported_parameters.filter((p): p is string => typeof p === 'string')
        if (params.includes('reasoning') || params.includes('include_reasoning') || params.includes('reasoning_effort')) model.reasoning = true
      }
      if (entry.thinking === true) model.reasoning = true
      const modalities = (entry.architecture as { input_modalities?: unknown } | undefined)?.input_modalities
      if (Array.isArray(modalities) && modalities.includes('image')) model.image = true
    }
    out.push(model)
  }
  return out
}

export function catalogKey(id: string): string {
  return id.trim().toLowerCase().replace(/:free$/, '').replace(/^.*\//, '').replace(/\./g, '-')
}

export interface PiCatalogEntry {
  provider: string
  api: string
  reasoning: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: ModelCost
}

export type PiModelCatalog = Record<string, PiCatalogEntry>

const ENDPOINT_APIS: Array<[string, CustomApiId]> = [
  ['/chat/completions', 'openai-completions'],
  ['/responses', 'openai-responses'],
  ['/messages', 'anthropic-messages']
]

function baseUrlForApi(baseUrl: string, from: string, to: CustomApiId): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const anthropic = (api: string) => api === 'anthropic-messages'
  if (anthropic(to) && !anthropic(from)) return trimmed.replace(/\/v\d+$/, '')
  if (!anthropic(to) && anthropic(from) && !/\/v\d+$/.test(trimmed)) return `${trimmed}/v1`
  return trimmed
}

export function describeDiscoveredModels(
  found: DiscoveredModel[],
  provider: { api: string; baseUrl: string },
  catalog: PiModelCatalog
): CustomProviderModel[] {
  return found.map((item) => {
    const model: CustomProviderModel = { id: item.id }
    if (item.name) model.name = item.name
    let api = provider.api
    const endpoints = item.endpoints ?? []
    const native = ENDPOINT_APIS.find(([, id]) => id === provider.api)?.[0]
    if (endpoints.length && native && !endpoints.includes(native)) {
      const alternative = ENDPOINT_APIS.find(([path]) => endpoints.includes(path))
      if (alternative) {
        api = alternative[1]
        model.api = alternative[1]
        model.baseUrl = baseUrlForApi(provider.baseUrl, provider.api, alternative[1])
      }
    }
    const known = catalog[catalogKey(item.id)]
    const reasoning = item.reasoning ?? known?.reasoning
    if (reasoning) model.reasoning = true
    if (item.image || known?.input?.includes('image')) model.input = ['text', 'image']
    const contextWindow = item.contextWindow ?? known?.contextWindow
    if (contextWindow) model.contextWindow = contextWindow
    if (known?.maxTokens) model.maxTokens = contextWindow ? Math.min(known.maxTokens, contextWindow) : known.maxTokens
    if (reasoning && known?.thinkingLevelMap && known.api === api && api !== 'openai-completions') {
      model.thinkingLevelMap = { ...known.thinkingLevelMap }
    }
    const cost = cleanModelCost(known?.cost)
    if (cost) model.cost = cost
    return model
  })
}

export interface LocalModelServer {
  kind: 'ollama' | 'lmstudio' | 'openai' | 'sdwebui' | 'comfyui'
  purpose: 'chat' | 'image'
  name: string
  baseUrl: string
  models: string[]
  suggestedId?: string
  running: boolean
  installDir?: string
}

export interface CustomProviderDiscoverResult {
  ok: boolean
  models: string[]
  entries?: CustomProviderModel[]
  message: string
}
