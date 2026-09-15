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

/**
 * 决定“本次 state 快照应该用哪组思考档位”。
 *
 * ── 为什么需要它 ──
 * pi 的 `get_state` **不返回档位**（它只给 `model` / `thinkingLevel` / `isStreaming`
 * 这些）；档位的权威来源是 `get_available_thinking_levels` 命令，由
 * `listThinkingLevels()` 写入。早期实现直接从 `get_state` 读
 * `availableThinkingLevels`，而那个字段永远不存在 —— 于是每条 state 推送
 * （流式增量、工具调用、状态变化都很频繁）都把档位重置成 `unknown`，
 * 界面就一直显示“上游未提供思考档位信息”，而 pi 实际上是有档位的
 * （用户报的 bug：支持推理的模型拿不到档位）。
 *
 * 规则：
 *   · 字段存在（pi 将来补上，或旧版 pi 有）→ 以它为准；
 *   · 字段缺失且**模型没变** → 沿用上一次已知结果（关键分支）；
 *   · 字段缺失且**模型变了** → 先清空成 unknown，等 listThinkingLevels() 回填。
 */
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
