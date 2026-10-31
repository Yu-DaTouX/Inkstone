import { useCallback, useMemo } from 'react'
import type { AuthProviderInfo, ModelInfo } from '../../../../shared/ipc'
import { modelKey, type ModelChoice } from '../../../../shared/model-selection'
import {
  sortByProviderThenNewest,
  toggleFavorite as toggleFavoriteChoice
} from '../../features/settings/models/models-model'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProviderInstanceEntry, ProviderInstanceId } from './contracts'
import { providerInstanceEntries } from './providers'
import type { ModelEsque } from '../components/chat/providerIconUtils'

export function providerModelKey(provider: string, model: string): string {
  return modelKey({ provider, id: model })
}

export function modelOptionsForProvider(
  models: ReadonlyArray<ModelInfo>,
  provider: string,
  order: ReadonlyArray<string> = [],
  hidden: ReadonlyArray<ModelChoice> = [],
): ModelEsque[] {
  const hiddenKeys = new Set(hidden.map(modelKey))
  return sortByProviderThenNewest(
    models.filter((model) => model.provider === provider && !hiddenKeys.has(modelKey(model))),
    order,
  ).map((model) => ({
    slug: model.id,
    name: model.name || model.id,
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(model.contextWindow > 0 && model.contextWindowAssumed !== true ? { contextWindow: model.contextWindow } : {}),
  }))
}

export function instanceEntriesFromModels(
  models: ReadonlyArray<ModelInfo>,
  order: ReadonlyArray<string> = [],
  providers: ReadonlyArray<AuthProviderInfo> = [],
  setupMessage: (kind: 'signIn' | 'apiKey') => string,
): ReadonlyArray<ProviderInstanceEntry> {
  return providerInstanceEntries({ models, providers, order, setupMessage })
}

export function sortProviderModelItems<T extends { instanceId: ProviderInstanceId; slug: string }>(
  items: ReadonlyArray<T>,
  input: {
    favoriteModelKeys: ReadonlySet<string>
    groupFavorites: boolean
    instanceOrder: ReadonlyArray<ProviderInstanceId>
  },
): T[] {
  if (!input.groupFavorites && input.instanceOrder.length === 0) return [...items]
  const instanceRank = (item: T): number => {
    const index = input.instanceOrder.indexOf(item.instanceId)
    return index < 0 ? input.instanceOrder.length : index
  }
  const favoriteRank = (item: T): number =>
    input.favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)) ? 0 : 1
  return [...items].sort(
    (a, b) => favoriteRank(a) - favoriteRank(b) || instanceRank(a) - instanceRank(b),
  )
}

export interface ComposerModelAdapter {
  activeInstanceId: ProviderInstanceId
  model: string
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
  favorites: ReadonlyArray<ModelChoice>
  favoriteKeys: ReadonlySet<string>
  select: (provider: ProviderInstanceId, model: string) => void
  toggleFavorite: (provider: ProviderInstanceId, model: string) => void
  openProviderSetup: () => void
}

const EMPTY_MODELS: ReadonlyArray<ModelInfo> = []
const EMPTY_PROVIDERS: ReadonlyArray<AuthProviderInfo> = []
const EMPTY_CHOICES: ReadonlyArray<ModelChoice> = []
const EMPTY_ORDER: ReadonlyArray<string> = []
const EMPTY_OPTIONS: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> = new Map()

export function useComposerModelAdapter(): ComposerModelAdapter {
  const t = useT()
  const models = useStore((s) => s.models) ?? EMPTY_MODELS
  const providers = useStore((s) => s.authProviders) ?? EMPTY_PROVIDERS
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const id = useStore((s) => s.session?.model?.id ?? '')
  const favorites = useStore((s) => s.settings?.modelFavorites) ?? EMPTY_CHOICES
  const hidden = useStore((s) => s.settings?.modelHidden) ?? EMPTY_CHOICES
  const order = useStore((s) => s.settings?.modelProviderOrder) ?? EMPTY_ORDER

  const instanceEntries = useMemo(
    () =>
      instanceEntriesFromModels(models, order, providers, (kind) =>
        t(kind === 'signIn' ? 'composer.t3.picker.needsSignIn' : 'composer.t3.picker.needsApiKey'),
      ),
    [models, order, providers, t],
  )
  const modelOptionsByInstance = useMemo(() => {
    if (models.length === 0) return EMPTY_OPTIONS
    const map = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>()
    for (const entry of instanceEntries) {
      map.set(entry.instanceId, modelOptionsForProvider(models, entry.instanceId, order, hidden))
    }
    return map
  }, [models, hidden, instanceEntries, order])
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((choice) => providerModelKey(choice.provider, choice.id))),
    [favorites],
  )

  const select = useCallback((nextProvider: ProviderInstanceId, nextModel: string) => {
    void useStore.getState().setModel(nextProvider, nextModel)
  }, [])

  const toggleFavorite = useCallback((nextProvider: ProviderInstanceId, nextModel: string) => {
    const current = useStore.getState().settings?.modelFavorites ?? []
    const name = useStore
      .getState()
      .models.find((model) => model.provider === nextProvider && model.id === nextModel)?.name
    const next = toggleFavoriteChoice(current, {
      provider: nextProvider,
      id: nextModel,
      ...(name ? { name } : {}),
    })
    void useStore.getState().patchSettings({ modelFavorites: next })
  }, [])

  const openProviderSetup = useCallback(() => {
    useStore.getState().openSettings('models')
  }, [])

  return {
    activeInstanceId: provider,
    model: id,
    instanceEntries,
    modelOptionsByInstance,
    favorites,
    favoriteKeys,
    select,
    toggleFavorite,
    openProviderSetup,
  }
}
