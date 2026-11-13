import type { AuthProviderInfo, ModelInfo } from '../../../../../shared/ipc'
import { cleanModelCost, type ModelCost } from '../../../../../shared/custom-provider'
import { modelKey, type ModelChoice } from '../../../../../shared/model-selection'

export type ServiceState = 'ready' | 'loginable' | 'missing' | 'unknown'

export function entryState(info: AuthProviderInfo): ServiceState {
  if (info.status === 'ready') return 'ready'
  if (info.status === 'unknown') return 'unknown'
  return info.inAppLogin ? 'loginable' : 'missing'
}

export function canRemoveCredential(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source !== 'env'
}

export function credentialFromEnv(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source === 'env'
}

function newestFirst(a: Pick<ModelChoice, 'provider' | 'id' | 'name'>, b: Pick<ModelChoice, 'provider' | 'id' | 'name'>): number {
  const family = (m: Pick<ModelChoice, 'id'>): string => m.id.match(/^[a-z]+/i)?.[0] ?? m.id
  const group = a.provider.localeCompare(b.provider) || family(a).localeCompare(family(b))
  if (group) return group
  const version = (m: Pick<ModelChoice, 'id'>): number[] =>
    (m.id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '').split(/[.-]/).map(Number)
  const av = version(a)
  const bv = version(b)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const difference = (bv[i] ?? 0) - (av[i] ?? 0)
    if (difference) return difference
  }
  return (
    (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true }) ||
    modelKey(a).localeCompare(modelKey(b))
  )
}

function providerRank(provider: string, order: readonly string[]): number {
  const i = order.indexOf(provider)
  return i < 0 ? order.length : i
}

export function isFavorite(favorites: readonly ModelChoice[], model: Pick<ModelChoice, 'provider' | 'id'>): boolean {
  const key = modelKey(model)
  return favorites.some((m) => modelKey(m) === key)
}

export function toggleFavorite(
  favorites: readonly ModelChoice[],
  model: Pick<ModelChoice, 'provider' | 'id' | 'name'>
): ModelChoice[] {
  const key = modelKey(model)
  if (favorites.some((m) => modelKey(m) === key)) {
    return favorites.filter((m) => modelKey(m) !== key)
  }
  return [...favorites, { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) }]
}

export function isHidden(hidden: readonly ModelChoice[], model: Pick<ModelChoice, 'provider' | 'id'>): boolean {
  const key = modelKey(model)
  return hidden.some((m) => modelKey(m) === key)
}

export function withHidden(
  hidden: readonly ModelChoice[],
  models: readonly Pick<ModelChoice, 'provider' | 'id' | 'name'>[],
  hide: boolean
): ModelChoice[] {
  const keys = new Set(models.map(modelKey))
  const rest = hidden.filter((m) => !keys.has(modelKey(m)))
  if (!hide) return rest
  return [...rest, ...models.map((m) => ({ provider: m.provider, id: m.id, ...(m.name ? { name: m.name } : {}) }))]
}

export function mergeDiscoveredModels<T extends { id: string }>(
  current: T[],
  discovered: T[],
  merge: (latest: T, found: T) => T
): T[] {
  const byId = new Map(discovered.map((entry) => [entry.id, entry]))
  const kept = current
    .filter((entry) => entry.id.trim())
    .map((entry) => {
      const found = byId.get(entry.id.trim())
      return found ? merge(entry, found) : entry
    })
  const ids = new Set(kept.map((entry) => entry.id.trim()))
  return [...kept, ...discovered.filter((entry) => !ids.has(entry.id))]
}

export function modelCostOf(model: Pick<ModelInfo, 'id'> & { cost?: unknown }): ModelCost | undefined {
  return cleanModelCost(model.cost)
}

export function priceLabel(cost: ModelCost | undefined): string {
  if (!cost) return ''
  const fmt = (value: number): string => `$${Math.round(value * 100) / 100}`
  return `${fmt(cost.input)} / ${fmt(cost.output)}`
}

export function sortByProviderThenNewest(models: readonly ModelInfo[], providerOrder: readonly string[]): ModelInfo[] {
  return [...models].sort(
    (a, b) =>
      providerRank(a.provider, providerOrder) - providerRank(b.provider, providerOrder) || newestFirst(a, b)
  )
}
