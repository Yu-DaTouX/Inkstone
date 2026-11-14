import type {
  CapabilityStatus,
  ModelCapabilitySnapshot,
  ModelInfo
} from './ipc'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function capabilityStatusForBoolean(value: unknown): CapabilityStatus {
  if (value === true) return 'known'
  if (value === false) return 'unsupported'
  return 'unknown'
}

export function isLocalBaseUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  let host: string
  try {
    host = new URL(raw.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') return true
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

export function modelKeyOf(model: Pick<ModelInfo, 'provider' | 'id'> | null | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined
  return `${model.provider}/${model.id}`
}

export function normalizeModelInfo(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const id = text(value.id)
  if (!id) return undefined
  const provider = text(value.provider) ?? 'unknown'
  const api = text(value.api)
  const name = text(value.name) ?? id
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : undefined
  const contextWindow = positiveNumber(value.contextWindow) ?? 0
  const maxTokens = positiveNumber(value.maxTokens)
  return {
    id,
    name,
    provider,
    ...(api ? { api } : {}),
    ...(isLocalBaseUrl(value.baseUrl) ? { local: true } : {}),
    reasoning: value.reasoning === true,
    reasoningStatus: capabilityStatusForBoolean(value.reasoning),
    ...(input ? { input } : {}),
    inputStatus: input ? (input.length ? 'known' : 'unsupported') : 'unknown',
    contextWindow,
    contextWindowStatus: contextWindow > 0 ? 'known' : 'unknown',
    ...(maxTokens ? { maxTokens } : {}),
    maxTokensStatus: maxTokens ? 'known' : 'unknown'
  }
}

export function normalizeThinkingLevels(
  raw: unknown,
  requestSucceeded: boolean
): { values: string[]; status: CapabilityStatus } {
  if (!requestSucceeded || !Array.isArray(raw)) return { values: [], status: 'unknown' }
  const values = [...new Set(raw.filter((item): item is string => typeof item === 'string' && !!item.trim()))]
  return { values, status: values.length ? 'known' : 'unsupported' }
}

export function resolveThinkingLevels(
  data: Record<string, unknown>,
  previous: { levels: string[]; status: CapabilityStatus; modelKey?: string } | undefined,
  currentModelKey: string | undefined
): { values: string[]; status: CapabilityStatus } {
  if (Object.prototype.hasOwnProperty.call(data, 'availableThinkingLevels')) {
    return normalizeThinkingLevels(data.availableThinkingLevels, true)
  }
  if (previous && previous.modelKey === currentModelKey) {
    return { values: previous.levels, status: previous.status }
  }
  return { values: [], status: 'unknown' }
}

export function capabilitySnapshot(
  model: ModelInfo | undefined,
  thinkingLevels: string[],
  thinkingLevelsStatus: CapabilityStatus
): ModelCapabilitySnapshot | undefined {
  if (!model) return undefined
  return {
    modelKey: modelKeyOf(model) ?? `${model.provider}/${model.id}`,
    reasoning: model.reasoningStatus ?? 'unknown',
    input: {
      status: model.inputStatus ?? 'unknown',
      modalities: model.input ?? []
    },
    contextWindow: {
      status: model.contextWindowStatus ?? (model.contextWindow > 0 ? 'known' : 'unknown'),
      ...(model.contextWindow > 0 ? { value: model.contextWindow } : {})
    },
    maxTokens: {
      status: model.maxTokensStatus ?? (model.maxTokens ? 'known' : 'unknown'),
      ...(model.maxTokens ? { value: model.maxTokens } : {})
    },
    thinkingLevels: {
      status: thinkingLevelsStatus,
      values: [...thinkingLevels]
    }
  }
}
