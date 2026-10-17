export const MODEL_BRANDS = ['claude', 'codex', 'deepseek', 'qwen', 'gemini', 'kimi', 'glm', 'grok', 'pi'] as const

export type ModelBrand = (typeof MODEL_BRANDS)[number]

export type ModelRef = string | { provider?: string | null; id?: string | null } | null | undefined

type BrandTable = ReadonlyArray<readonly [RegExp, ModelBrand]>

const PROVIDER_BRANDS: BrandTable = [
  [/^(anthropic|claude-bridge|claude-code|claude)$/, 'claude'],
  [/^(openai|openai-codex|azure-openai-responses|chatgpt|codex)$/, 'codex'],
  [/^(deepseek|deepseek-cn)$/, 'deepseek'],
  [/^(qwen|qwen-portal|qwen-code|qwen-cli)$/, 'qwen'],
  [/^(google|google-vertex|google-generative-ai|google-gemini-cli|gemini|gemini-cli)$/, 'gemini'],
  [/^(moonshot|moonshot-cn|moonshotai|moonshotai-cn|kimi|kimi-cn|kimi-coding)$/, 'kimi'],
  [/^(zai|zai-coding|zai-coding-cn|zhipu|zhipuai|zhipu-cn|bigmodel|glm)$/, 'glm'],
  [/^(xai|x-ai|grok)$/, 'grok']
]

const VENDOR_BRANDS: BrandTable = [
  [/^(anthropic|claude)$/, 'claude'],
  [/^(openai|chatgpt)$/, 'codex'],
  [/^(deepseek|deepseek-ai)$/, 'deepseek'],
  [/^(qwen|alibaba|alibaba-cloud|dashscope)$/, 'qwen'],
  [/^(google|gemini)$/, 'gemini'],
  [/^(moonshot|moonshotai|kimi)$/, 'kimi'],
  [/^(z-ai|zai|zai-org|thudm|zhipu|zhipuai|glm)$/, 'glm'],
  [/^(x-ai|xai|grok)$/, 'grok']
]

const ID_BRANDS: BrandTable = [
  [/claude|(^|[^a-z])(sonnet|opus|haiku)($|[^a-z])/, 'claude'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq|qvq/, 'qwen'],
  [/gemini/, 'gemini'],
  [/kimi|moonshot/, 'kimi'],
  [/(^|[^a-z])(chat)?glm/, 'glm'],
  [/grok/, 'grok'],
  [/codex|chatgpt|(^|[^a-z])gpt|^o\d($|[-.])/, 'codex']
]

export function modelBrand(ref: ModelRef): ModelBrand {
  const { provider, id } = splitModelRef(ref)
  const direct = provider ? matchFirst(PROVIDER_BRANDS, provider) : null
  if (direct) return direct
  const segments = id.split('/').filter(Boolean)
  for (const segment of segments.slice(0, -1)) {
    const vendor = matchFirst(VENDOR_BRANDS, segment)
    if (vendor) return vendor
  }
  const name = (segments.at(-1) ?? '').replace(/^([a-z]{2}\.)?[a-z-]+\./, '')
  return matchFirst(ID_BRANDS, name) ?? 'pi'
}

export function splitModelRef(ref: ModelRef): { provider: string; id: string } {
  if (!ref) return { provider: '', id: '' }
  if (typeof ref === 'object') {
    return { provider: clean(ref.provider ?? ''), id: stripThinking(clean(ref.id ?? '')) }
  }
  const text = stripThinking(clean(ref))
  const slash = text.indexOf('/')
  if (slash <= 0) return { provider: '', id: text }
  return { provider: text.slice(0, slash), id: text.slice(slash + 1) }
}

function clean(value: string): string {
  return value.trim().toLowerCase()
}

function stripThinking(value: string): string {
  return value.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, '')
}

function matchFirst(table: BrandTable, value: string): ModelBrand | null {
  for (const [pattern, brand] of table) if (pattern.test(value)) return brand
  return null
}
