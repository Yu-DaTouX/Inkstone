import type { AuthProviderInfo, CapabilityStatus, ModelInfo } from '../../../../../shared/ipc'
import { cleanModelCost, type ModelCost } from '../../../../../shared/custom-provider'
import { cleanModelFavorites, modelKey, type ModelChoice } from '../../../../../shared/model-selection'

export type ServiceState = 'ready' | 'loginable' | 'missing' | 'unknown'

export function authInfoFor(
  provider: string,
  providers: readonly AuthProviderInfo[]
): AuthProviderInfo | undefined {
  const id = String(provider ?? '').trim()
  if (!id) return undefined
  return providers.find((info) => info.id === id || (info.authKey !== '' && info.authKey === id))
}

export function entryState(info: AuthProviderInfo): ServiceState {
  if (info.status === 'ready') return 'ready'
  if (info.status === 'unknown') return 'unknown'
  return info.inAppLogin ? 'loginable' : 'missing'
}

export function serviceState(provider: string, providers: readonly AuthProviderInfo[]): ServiceState {
  const info = authInfoFor(provider, providers)
  return info ? entryState(info) : 'unknown'
}

export function canRemoveCredential(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source !== 'env'
}

export function credentialFromEnv(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source === 'env'
}

export function needsInAppLogin(info: AuthProviderInfo): boolean {
  return info.kind === 'subscription' && info.inAppLogin === true
}

export interface ServiceSplit {
  subscriptions: AuthProviderInfo[]
  keys: AuthProviderInfo[]
  readyKeys: AuthProviderInfo[]
  otherKeys: AuthProviderInfo[]
}

export function splitServices(providers: readonly AuthProviderInfo[]): ServiceSplit {
  const subscriptions = providers.filter((p) => p.kind === 'subscription')
  const keys = providers.filter((p) => p.kind !== 'subscription')
  return {
    subscriptions,
    keys,
    readyKeys: keys.filter((p) => p.status === 'ready'),
    otherKeys: keys.filter((p) => p.status !== 'ready')
  }
}

export function serviceSummary(providers: readonly AuthProviderInfo[]): { ready: number; total: number } {
  return { ready: providers.filter((p) => p.status === 'ready').length, total: providers.length }
}

export interface CatalogModel {
  key: string
  provider: string
  id: string
  name: string
  reasoning: boolean
  reasoningStatus: CapabilityStatus
  contextWindow: number
  contextWindowStatus: CapabilityStatus
  input: string[]
  inputStatus: CapabilityStatus
  available: boolean
  starred: boolean
}

export interface CatalogInput {
  models: readonly ModelInfo[]
  favorites: readonly ModelChoice[]
  query: string
  provider: string
  favoriteOnly: boolean
  providerOrder: readonly string[]
}

export function newestFirst(a: Pick<ModelChoice, 'provider' | 'id' | 'name'>, b: Pick<ModelChoice, 'provider' | 'id' | 'name'>): number {
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

export function providerRank(provider: string, order: readonly string[]): number {
  const i = order.indexOf(provider)
  return i < 0 ? order.length : i
}

export function catalogProviders(input: Pick<CatalogInput, 'models' | 'favorites' | 'providerOrder'>): string[] {
  const all = [
    ...new Set([
      ...input.models.map((m) => m.provider),
      ...input.favorites.map((m) => m.provider)
    ])
  ]
  return all.sort(
    (a, b) =>
      providerRank(a, input.providerOrder) - providerRank(b, input.providerOrder) || a.localeCompare(b)
  )
}

function toRow(
  choice: Pick<ModelChoice, 'provider' | 'id' | 'name'>,
  model: ModelInfo | undefined,
  favorites: ReadonlySet<string>
): CatalogModel {
  return {
    key: modelKey(choice),
    provider: choice.provider,
    id: choice.id,
    name: model?.name || choice.name || choice.id,
    reasoning: model?.reasoning === true,
    reasoningStatus: model?.reasoningStatus ?? 'unknown',
    contextWindow: model?.contextWindow ?? 0,
    contextWindowStatus: model?.contextWindowStatus ?? (model && model.contextWindow > 0 ? 'known' : 'unknown'),
    input: model?.input ? [...model.input] : [],
    inputStatus: model?.inputStatus ?? (model?.input ? 'known' : 'unknown'),
    available: !!model,
    starred: favorites.has(modelKey(choice))
  }
}

export function buildCatalogRows(input: CatalogInput): CatalogModel[] {
  const byKey = new Map<string, ModelInfo>()
  for (const m of input.models) byKey.set(modelKey(m), m)
  const choices = new Map<string, Pick<ModelChoice, 'provider' | 'id' | 'name'>>()
  for (const m of input.models) choices.set(modelKey(m), { provider: m.provider, id: m.id, name: m.name })
  for (const m of input.favorites) if (!choices.has(modelKey(m))) choices.set(modelKey(m), m)

  const favorites = new Set(input.favorites.map(modelKey))
  const q = input.query.trim().toLowerCase()
  const provider = input.provider

  return [...choices.values()]
    .filter((m) => {
      if (input.favoriteOnly && !favorites.has(modelKey(m))) return false
      if (!input.favoriteOnly && provider && m.provider !== provider) return false
      if (!q) return true
      return `${m.name ?? ''} ${m.id} ${m.provider}`.toLowerCase().includes(q)
    })
    .map((m) => toRow(m, byKey.get(modelKey(m)), favorites))
    .sort(
      (a, b) =>
        providerRank(a.provider, input.providerOrder) - providerRank(b.provider, input.providerOrder) ||
        newestFirst(a, b)
    )
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

export type ThinkingView =
  | { kind: 'levels'; values: string[] }
  | { kind: 'no-levels' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }

export function thinkingView(
  levels: readonly string[],
  status: CapabilityStatus | undefined
): ThinkingView {
  if (status === undefined || status === 'unknown') return { kind: 'unknown' }
  if (status === 'unsupported') return { kind: 'unsupported' }
  return levels.length > 1 ? { kind: 'levels', values: [...levels] } : { kind: 'no-levels' }
}

export const RECENT_STORAGE_KEY = 'inkstone.v3.modelPicker.recent'
export const MAX_RECENT = 5

export function shortWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

export function modelCostOf(model: Pick<ModelInfo, 'id'> & { cost?: unknown }): ModelCost | undefined {
  return cleanModelCost(model.cost)
}

export function priceLabel(cost: ModelCost | undefined): string {
  if (!cost) return ''
  const fmt = (value: number): string => `$${Math.round(value * 100) / 100}`
  return `${fmt(cost.input)} / ${fmt(cost.output)}`
}

export function parseRecentModels(raw: string | null | undefined): ModelChoice[] {
  if (!raw) return []
  try {
    return cleanModelFavorites(JSON.parse(raw)).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function recentModelsAfterPick(
  recent: readonly ModelChoice[],
  picked: Pick<ModelChoice, 'provider' | 'id' | 'name'>,
  max = MAX_RECENT
): ModelChoice[] {
  const choice: ModelChoice = {
    provider: picked.provider,
    id: picked.id,
    ...(picked.name ? { name: picked.name } : {})
  }
  const key = modelKey(choice)
  return [choice, ...recent.filter((m) => modelKey(m) !== key)].slice(0, max)
}

export type PickerSectionKind = 'favorites' | 'recent' | 'provider'

export interface PickerSection {
  id: string
  kind: PickerSectionKind
  models: ModelInfo[]
}

function sortByProviderThenNewest(models: readonly ModelInfo[], providerOrder: readonly string[]): ModelInfo[] {
  return [...models].sort(
    (a, b) =>
      providerRank(a.provider, providerOrder) - providerRank(b.provider, providerOrder) || newestFirst(a, b)
  )
}

export function buildPickerSections(input: {
  models: readonly ModelInfo[]
  favorites: readonly ModelChoice[]
  recent: readonly ModelChoice[]
  query: string
  providerOrder: readonly string[]
}): PickerSection[] {
  const q = input.query.trim().toLowerCase()
  const matches = (m: ModelInfo): boolean => !q || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q)
  const shown = input.models.filter(matches)
  const byKey = new Map(shown.map((m) => [modelKey(m), m]))
  const favoriteKeys = new Set(input.favorites.map(modelKey))

  const favorites = sortByProviderThenNewest(
    input.models.filter((m) => favoriteKeys.has(modelKey(m)) && matches(m)),
    input.providerOrder
  )
  const pinned = new Set(favorites.map(modelKey))
  const recent = input.recent
    .map((choice) => byKey.get(modelKey(choice)))
    .filter((m): m is ModelInfo => !!m && !pinned.has(modelKey(m)))

  const used = new Set([...pinned, ...recent.map(modelKey)])
  const groups = new Map<string, ModelInfo[]>()
  for (const m of shown) {
    if (used.has(modelKey(m))) continue
    const list = groups.get(m.provider) ?? []
    list.push(m)
    groups.set(m.provider, list)
  }
  const providerSections: PickerSection[] = [...groups.entries()]
    .sort(
      ([a], [b]) =>
        providerRank(a, input.providerOrder) - providerRank(b, input.providerOrder) || a.localeCompare(b)
    )
    .map(([provider, list]) => ({ id: provider, kind: 'provider', models: [...list].sort(newestFirst) }))

  const sections: PickerSection[] = []
  if (favorites.length) sections.push({ id: 'favorites', kind: 'favorites', models: favorites })
  if (recent.length) sections.push({ id: 'recent', kind: 'recent', models: recent })
  return [...sections, ...providerSections]
}
