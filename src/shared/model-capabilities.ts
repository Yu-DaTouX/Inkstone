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

export function modelKeyOf(model: Pick<ModelInfo, 'provider' | 'id'> | null | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined
  return `${model.provider}/${model.id}`
}

/**
 * Normalize pi's model descriptor without guessing from the model name.
 *
 * Older pi builds omit input/reasoning/context fields. Those omissions stay
 * `unknown`; they are never turned into “unsupported” merely because the
 * field is absent.
 */
export function normalizeModelInfo(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const id = text(value.id)
  if (!id) return undefined
  const provider = text(value.provider) ?? 'unknown'
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
