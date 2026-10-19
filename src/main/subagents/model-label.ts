export interface ModelLabelCandidate {
  provider: string
  id: string
  name?: string
}

export type ModelLabelResolution = { ok: true; label: string } | { ok: false; error: string }

const MAX_LISTED = 8

function lower(value: string): string {
  return value.trim().toLowerCase()
}

function labelOf(model: ModelLabelCandidate): string {
  return `${model.provider}/${model.id}`
}

function matches(model: ModelLabelCandidate, wanted: string): boolean {
  const id = lower(model.id)
  const full = lower(labelOf(model))
  return id === wanted || id.endsWith(`/${wanted}`) || full.endsWith(`/${wanted}`) || (!!model.name && lower(model.name) === wanted)
}

export function resolveSubagentModelLabel(
  requested: string,
  models: readonly ModelLabelCandidate[],
  parentLabel?: string
): ModelLabelResolution {
  const raw = requested.trim()
  if (!raw || models.length === 0) return { ok: true, label: raw }
  const exact = models.find((model) => labelOf(model) === raw)
  if (exact) return { ok: true, label: raw }
  const wanted = lower(raw)
  const hits = models.filter((model) => matches(model, wanted))
  if (hits.length === 1) return { ok: true, label: labelOf(hits[0]) }
  if (hits.length === 0) return { ok: true, label: raw }
  const parentProvider = parentLabel?.split('/')[0]
  const sameProvider = parentProvider ? hits.filter((model) => model.provider === parentProvider) : []
  if (sameProvider.length === 1) return { ok: true, label: labelOf(sameProvider[0]) }
  const listed = hits.slice(0, MAX_LISTED).map(labelOf)
  const more = hits.length > MAX_LISTED ? ` 等 ${hits.length} 个` : ''
  return { ok: false, error: `模型「${raw}」对应多个已登录的模型：${listed.join('、')}${more}。请用其中一个完整名称（供应商/模型）重新启动，不要改用其他模型。` }
}

export interface SubagentModelPreference {
  model?: { provider: string; id: string }
  force?: boolean
}

export function resolveSubagentModelPick(
  requested: string | undefined,
  models: readonly ModelLabelCandidate[],
  parentLabel: string | undefined,
  preference: SubagentModelPreference = {}
): ModelLabelResolution {
  const explicit = requested?.trim() ?? ''
  const preferredLabel = preference.model ? labelOf(preference.model) : ''
  const preferredUsable = !!preferredLabel && (models.length === 0 || models.some((model) => labelOf(model) === preferredLabel))
  const picked = preferredUsable && preference.force ? preferredLabel : explicit || (preferredUsable ? preferredLabel : '')
  if (!picked) return { ok: true, label: '' }
  return resolveSubagentModelLabel(picked, models, parentLabel)
}
