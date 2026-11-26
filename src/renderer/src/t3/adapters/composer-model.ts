import { useCallback, useMemo, useRef, useState } from 'react'
import { ANTIGRAVITY_PROVIDER } from '../../../../shared/antigravity'
import type { AuthProviderInfo, ModelInfo } from '../../../../shared/ipc'
import { modelKey, type ModelChoice } from '../../../../shared/model-selection'
import {
  sortByProviderThenNewest,
  toggleFavorite as toggleFavoriteChoice
} from '../../features/settings/models/models-model'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useAntigravityDiscovery } from '../../state/antigravity-discovery'
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
  activeModelName?: string
  switching: string | null
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
  favorites: ReadonlyArray<ModelChoice>
  favoriteKeys: ReadonlySet<string>
  select: (provider: ProviderInstanceId, model: string) => void
  toggleFavorite: (provider: ProviderInstanceId, model: string) => void
  openProviderSetup: (provider?: ProviderInstanceId) => void
  discoverAntigravity: () => void
}

const EMPTY_MODELS: ReadonlyArray<ModelInfo> = []
const EMPTY_PROVIDERS: ReadonlyArray<AuthProviderInfo> = []
const EMPTY_CHOICES: ReadonlyArray<ModelChoice> = []
const EMPTY_ORDER: ReadonlyArray<string> = []

export function useComposerModelAdapter(): ComposerModelAdapter {
  const t = useT()
  const { lang } = useI18n()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd)
  const { discovery: external, discover: discoverAntigravity } = useAntigravityDiscovery(cwd)
  const models = useStore((s) => s.models) ?? EMPTY_MODELS
  const providers = useStore((s) => s.authProviders) ?? EMPTY_PROVIDERS
  const remembered = useStore((s) => (s.session ? '' : s.sessions.find((item) => item.id === s.peekedSessionId)?.model ?? ''))
  const split = remembered.indexOf('/')
  const provider = useStore((s) => s.session?.model?.provider ?? '') || (split > 0 ? remembered.slice(0, split) : '')
  const id = useStore((s) => s.session?.model?.id ?? '') || (split > 0 ? remembered.slice(split + 1) : '')
  const activeModelName = useStore((s) => s.session?.model?.provider === ANTIGRAVITY_PROVIDER ? s.session.model.name : undefined)
  const favorites = useStore((s) => s.settings?.modelFavorites) ?? EMPTY_CHOICES
  const hidden = useStore((s) => s.settings?.modelHidden) ?? EMPTY_CHOICES
  const order = useStore((s) => s.settings?.modelProviderOrder) ?? EMPTY_ORDER

  const instanceEntries = useMemo(
    () => {
      const ready = !!external?.models?.length
      return [
        ...instanceEntriesFromModels(models, order, providers, (kind) =>
          t(kind === 'signIn' ? 'composer.t3.picker.needsSignIn' : 'composer.t3.picker.needsApiKey'),
        ).filter((entry) => entry.instanceId !== ANTIGRAVITY_PROVIDER),
        {
          instanceId: ANTIGRAVITY_PROVIDER, driverKind: ANTIGRAVITY_PROVIDER, displayName: 'Antigravity',
          enabled: true, installed: ready, isAvailable: ready, status: ready ? 'ready' as const : 'warning' as const,
          needsSetup: !ready,
          snapshot: { message: external?.error ?? (external?.models?.length === 0
            ? lang === 'en-US' ? 'No models returned by the CLI.' : 'CLI 没有返回可用模型。'
            : lang === 'en-US' ? 'Checking Antigravity CLI…' : '正在查找 Antigravity CLI 模型…') },
        },
      ]
    },
    [models, order, providers, external, lang, t],
  )
  const modelOptionsByInstance = useMemo(() => {
    const map = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>()
    for (const entry of instanceEntries) {
      map.set(entry.instanceId, entry.instanceId === ANTIGRAVITY_PROVIDER
        ? (external?.models ?? []).map(({ id, name }) => ({ slug: id, name }))
        : modelOptionsForProvider(models, entry.instanceId, order, hidden))
    }
    return map
  }, [models, external, hidden, instanceEntries, order])
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((choice) => providerModelKey(choice.provider, choice.id))),
    [favorites],
  )

  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const [pending, setPending] = useState<{ runId: string | null; name: string } | null>(null)
  const optionsRef = useRef(modelOptionsByInstance)
  optionsRef.current = modelOptionsByInstance
  const select = useCallback((nextProvider: ProviderInstanceId, nextModel: string) => {
    const name = optionsRef.current.get(nextProvider)?.find((option) => option.slug === nextModel)?.name || nextModel
    const entry = { runId: useStore.getState().activeRunnerId, name }
    setPending(entry)
    void useStore.getState().setModel(nextProvider, nextModel).finally(() => {
      setPending((current) => (current === entry ? null : current))
    })
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
    activeModelName,
    switching: pending && pending.runId === activeRunnerId ? pending.name : null,
    instanceEntries,
    modelOptionsByInstance,
    favorites,
    favoriteKeys,
    select,
    toggleFavorite,
    openProviderSetup,
    discoverAntigravity,
  }
}
