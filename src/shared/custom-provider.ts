/*
 * 自定义 API 服务（实施-23 M1）。
 *
 * ── 单一真源 ──
 * 真源就是 pi 自己的 `models.json`（`{ providers: { [id]: {...} } }`）。
 * 砚只拥有其中**以 `yan-` 开头的条目**，其它 provider（包括用户手工写的）
 * 一律原样保留 —— 合并是逐键的，不整文件覆盖。
 *
 * ── 密钥 ──
 * pi 的 provider 定义支持 `apiKey` 字面量。这里**只允许字面量**：
 * `!command`（可执行字符串）是拒绝的，不允许从一个普通 UI 表单落盘。
 * 读回给渲染端时只给 `hasApiKey`，永远不回明文。
 *
 * M0 实测（隔离 `PI_CODING_AGENT_DIR` + `pi --list-models`）：
 *   · 文件路径 = `<agent dir>/models.json`；
 *   · provider 必填 `baseUrl`（小写 u）与 `models[]`；
 *   · 模型字段 `id` / `name` / `contextWindow` / `maxTokens` / `reasoning` / `input`；
 *   · pi 的内置目录用到的 api ID 见 `PI_API_IDS`。
 */

/** pi 0.87.1 内置模型目录里出现过的全部 api ID（从 bundle 提取） */
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

/**
 * 通用「自定义服务」表单允许选择的协议。
 *
 * 其余（vertex / azure / bedrock / codex / openrouter-images）不是"填一个
 * Base URL 就能用"的：它们各自需要项目、区域、deployment 或 OAuth 凭证，
 * 因此不在首版表单里 —— 不能因为底层有适配器就显示成可用选项。
 */
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
}

/** 读回渲染端的形状：**不含** apiKey 明文 */
export interface CustomProviderView {
  id: string
  api: string
  baseUrl: string
  models: CustomProviderModel[]
  hasApiKey: boolean
}

/** 写盘时的形状（apiKey 可选：编辑时不重新输入就沿用旧值） */
export interface CustomProviderInput {
  id: string
  api: string
  baseUrl: string
  models: CustomProviderModel[]
  apiKey?: string
}

export const CUSTOM_PROVIDER_PREFIX = 'yan-'

/** 砚拥有的条目：`yan-` 前缀 + 合法字符 */
export function isYanProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^yan-[a-z0-9][a-z0-9-]*$/.test(value)
}

/** `!command` 这类可执行字符串：不允许作为普通表单输入落盘 */
export function hasExecutablePrefix(value: string): boolean {
  return value.trimStart().startsWith('!')
}

/** Base URL 校验：只接受 http/https 的绝对地址 */
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

/** 表单 → 可写盘的定义；任何一条不合格都不返回 value */
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
    cleaned.push(next)
  }
  if (!cleaned.length) errors.push('至少要有一个模型')
  if (typeof input.apiKey === 'string' && hasExecutablePrefix(input.apiKey)) {
    errors.push('API Key 不能是 ! 开头的可执行字符串')
  }

  if (errors.length) return { ok: false, errors }
  const value: CustomProviderInput = { id, api, baseUrl: String(input.baseUrl).trim(), models: cleaned }
  /* key 只在用户真的填了的时候带上；没填 = 沿用旧值（由合并逻辑决定） */
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) value.apiKey = input.apiKey.trim()
  return { ok: true, errors: [], value }
}

type Json = Record<string, unknown>

/** 从 models.json 里读出砚拥有的自定义服务（不含密钥明文） */
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
          return model
        })
        .filter((m) => m.id),
      /* 只报告有没有，不回明文 */
      hasApiKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 把砚的自定义服务合并进 models.json：
 *   · 只动 `yan-` 前缀的条目；
 *   · 其它 provider 与顶层未知字段**原样保留**；
 *   · 没带 apiKey 的更新沿用磁盘上的旧 key（用户不必每次重输）。
 */
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
    entry.models = update.models
    if (update.apiKey) entry.apiKey = update.apiKey
    else if (typeof previous.apiKey === 'string') entry.apiKey = previous.apiKey
    providers[update.id] = entry
    changed = true
  }

  if (!changed) return { next: base, changed: false }
  base.providers = providers
  return { next: base, changed: true }
}

/** 渲染端展示用：把 key 换成存在状态（任何日志 / 快照都走它） */
export function maskCustomProvider(view: CustomProviderView): CustomProviderView & { apiKeyLabel: string } {
  return { ...view, apiKeyLabel: view.hasApiKey ? '••••••' : '' }
}

/**
 * 连接测试结果（实施-23 M2）。
 *
 * 两段刻意分成同一个类型的不同 mode：界面要分别显示「免费检查」与「计费请求」，
 * 结果里也带着毫秒数，用户能看出是慢在网络上还是慢在模型上。
 */
export type CustomProviderTestMode = 'endpoint' | 'billable'

export interface CustomProviderTestResult {
  ok: boolean
  mode: CustomProviderTestMode
  ms: number
  message: string
  /** 计费段才有：模型回复的正文 */
  text?: string
}
