/**
 * 设置 → 模型与服务的**纯逻辑**（S1）。
 *
 * 为什么单独一份、不写在组件里：服务状态判定、模型目录过滤 / 排序 / 收藏、
 * 思考档位展示都属于纯函数，可以在 Node（esbuild 编译后）里直接钉死，不必启动
 * Electron、不碰 store、不发任何网络请求。组件只负责画、绑事件、调正式 store。
 *
 * 这里**不 import React、不读 store、不调 window**；入参全是权威数据：
 *   · 服务状态来自 `AuthProviderInfo`（主进程 credentials.ts 读 auth.json + 环境变量）；
 *   · 模型能力来自 `ModelInfo`（pi 的 listModels 归一化结果）；
 *   · 思考档位来自当前会话的 `thinkingLevels` + `thinkingLevelsStatus`
 *     （权威命令是 pi 的 `get_available_thinking_levels`，见 shared/model-capabilities.ts）。
 *
 * 本地 profile（lastMainModel / modelFavorites）只表示「上次选过 / 收藏过」，
 * **绝不是已登录**，判定服务是否可用一律看 `AuthProviderInfo.status`。
 */
import type { AuthProviderInfo, CapabilityStatus, ModelInfo } from '../../../../../shared/ipc'
import { cleanModelCost, type ModelCost } from '../../../../../shared/custom-provider'
import { cleanModelFavorites, modelKey, type ModelChoice } from '../../../../../shared/model-selection'

/* ------------------------------------------------------------------ 服务状态 */

/**
 * 一个服务商在界面上的三档状态。
 *
 * `loginable` 只表示「这个服务商有应用内登录模块」，不代表已经登录；
 * `ready` 才是主进程确认凭证可用（auth.json 或环境变量）。
 */
export type ServiceState = 'ready' | 'loginable' | 'missing' | 'unknown'

/** 按 provider id 或 authKey 找权威凭证条目（不含任何密钥，只是状态）。 */
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

/**
 * 能否在设置里移除这份凭证。
 *
 * 环境变量提供的凭证「移除」不掉（要去改环境变量），所以只对
 * `source !== 'env'` 的已配置条目显示移除动作 —— 不做点了没用的按钮。
 */
export function canRemoveCredential(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source !== 'env'
}

/** 凭证由环境变量提供（界面上要说明为什么没有「移除」）。 */
export function credentialFromEnv(info: AuthProviderInfo | undefined): boolean {
  return !!info && info.status === 'ready' && info.source === 'env'
}

/** 服务商是否需要走应用内 OAuth 登录（而非填 API key）。 */
export function needsInAppLogin(info: AuthProviderInfo): boolean {
  return info.kind === 'subscription' && info.inAppLogin === true
}

export interface ServiceSplit {
  subscriptions: AuthProviderInfo[]
  keys: AuthProviderInfo[]
  /** 已配置的 API key：常显，不折进「其他」。 */
  readyKeys: AuthProviderInfo[]
  /** 未配置的 API key：默认折叠。 */
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

/* ------------------------------------------------------------------ 模型目录 */

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
  /** 是否在本机 pi 的可用模型列表里（收藏但已不可用的仍会显示）。 */
  available: boolean
  starred: boolean
}

export interface CatalogInput {
  models: readonly ModelInfo[]
  favorites: readonly ModelChoice[]
  query: string
  /** '' = 全部供应商。 */
  provider: string
  favoriteOnly: boolean
  providerOrder: readonly string[]
}

/** 版本号降序（本地目录排序用，不是发布日期的猜测）。 */
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

/** 用户拖过的供应商在前，其余按字母接在后面。 */
export function providerRank(provider: string, order: readonly string[]): number {
  const i = order.indexOf(provider)
  return i < 0 ? order.length : i
}

/** 目录里出现过的供应商（含收藏但已不可用的），按用户顺序 + 字母排序。 */
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

/**
 * 组装模型目录行：可用模型 + 收藏（含已不可用的旧收藏），按查询 / 供应商 /
 * 只看收藏过滤，再按用户供应商顺序 + 版本排序。过滤与收藏都不选择运行时模型。
 */
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

/**
 * 收藏 / 取消收藏；不改动任何运行时模型，只返回新的偏好列表。
 * 收藏项只记 provider / id / 可选 name，绝不包含凭证。
 */
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

/* ------------------------------------------------------------------ 思考能力 */

/**
 * 当前会话模型的思考档位展示。
 *
 * 权威来源是 pi 的 `get_available_thinking_levels`（store 的 `thinkingLevels`
 * + `session.thinkingLevelsStatus`）。**不按模型名硬编码「支持思考」**：
 * `unknown` 表示这次协议没给能力，`unsupported` 才是上游明确说不支持。
 */
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

/* ------------------------------------------------------------------ 输入框模型选择器 */

/**
 * 「最近使用」只在 v3 命名空间的 localStorage 里，不进主进程设置字段。
 * 它只是浏览偏好：坏了最多少几条快捷项，不影响模型可用性判定。
 */
export const RECENT_STORAGE_KEY = 'inkstone.v3.modelPicker.recent'
export const MAX_RECENT = 5

/** 上下文窗口提示：`1M` / `200k` / 数字；0 表示未知，返回空串。 */
export function shortWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

/**
 * 模型报价：只认模型对象上已有的 `cost`，**不按模型名 / 供应商猜价格**。
 * `ModelInfo` 当前不带 cost 时返回 undefined，界面就不显示价格提示。
 */
export function modelCostOf(model: Pick<ModelInfo, 'id'> & { cost?: unknown }): ModelCost | undefined {
  return cleanModelCost(model.cost)
}

/** 每百万 token 的输入 / 输出价（美元）；没有报价返回空串。 */
export function priceLabel(cost: ModelCost | undefined): string {
  if (!cost) return ''
  const fmt = (value: number): string => `$${Math.round(value * 100) / 100}`
  return `${fmt(cost.input)} / ${fmt(cost.output)}`
}

/** localStorage 里的最近使用解析：坏值一律当空，不抛。 */
export function parseRecentModels(raw: string | null | undefined): ModelChoice[] {
  if (!raw) return []
  try {
    return cleanModelFavorites(JSON.parse(raw)).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/** 记一次选择：去重后置顶，最多 MAX_RECENT 条。 */
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
  /** `favorites` / `recent` / 供应商 id；用作 React key 与分组标题来源。 */
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

/**
 * 选择器分组：**收藏置顶 → 最近使用 → 其余按服务分组**。
 *
 * 只列本机 `models` 里确实存在的模型：旧收藏 / 旧最近若已不可用就不出现
 * （它们没法被选，列出来只会诱导误点）。搜索词同时过滤各分组，置顶分组也不会绕过搜索。
 */
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
