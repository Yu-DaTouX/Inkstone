import { useMemo, useState, type ReactElement } from 'react'
import { Star } from 'lucide-react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, IconButton, SearchField, Switch } from '../../../ui'
import { modelKey } from '../../../../../shared/model-selection'
import type { ModelInfo } from '../../../../../shared/ipc'
import { SettingsGroup } from '../root/controls'
import { isFavorite, isHidden, sortByProviderThenNewest, toggleFavorite, withHidden } from './models-model'
import { useModelsText } from './models-text'

const FILTER_AT = 8
const EMPTY: never[] = []

export function ModelVisibilityGroup(): ReactElement {
  const t = useT()
  const text = useModelsText()
  const models = useStore((s) => s.models)
  const favorites = useStore((s) => s.settings?.modelFavorites ?? EMPTY)
  const hidden = useStore((s) => s.settings?.modelHidden ?? EMPTY)
  const providerOrder = useStore((s) => s.settings?.modelProviderOrder ?? EMPTY)
  const patchSettings = useStore((s) => s.patchSettings)
  const notify = useStore((s) => s.notify)
  const [query, setQuery] = useState('')

  const sorted = useMemo(() => sortByProviderThenNewest(models, providerOrder), [models, providerOrder])
  const q = query.trim().toLowerCase()
  const shown = q ? sorted.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q)) : sorted
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>()
    for (const m of shown) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m])
    return [...byProvider.entries()]
  }, [shown])

  const hiddenCount = models.filter((m) => isHidden(hidden, m) && !isFavorite(favorites, m)).length
  const favoriteCount = models.filter((m) => isFavorite(favorites, m)).length

  const save = (patch: Parameters<typeof patchSettings>[0]): void => {
    void patchSettings(patch).catch(() => notify('error', t('models.selectFailed')))
  }

  const setHidden = (list: readonly ModelInfo[], hide: boolean): void => {
    const state = useStore.getState().settings
    const targets = hide ? list.filter((m) => !isFavorite(state?.modelFavorites ?? [], m)) : list
    save({ modelHidden: withHidden(state?.modelHidden ?? [], targets, hide) })
  }

  const toggleStar = (m: ModelInfo): void => {
    const state = useStore.getState().settings
    const adding = !isFavorite(state?.modelFavorites ?? [], m)
    save({
      modelFavorites: toggleFavorite(state?.modelFavorites ?? [], m),
      ...(adding && isHidden(state?.modelHidden ?? [], m) ? { modelHidden: withHidden(state?.modelHidden ?? [], [m], false) } : {})
    })
  }

  const counter = [
    text('visCount').replace('{n}', String(models.length)),
    favoriteCount ? text('visCountFav').replace('{n}', String(favoriteCount)) : '',
    hiddenCount ? text('visCountHidden').replace('{n}', String(hiddenCount)) : ''
  ].filter(Boolean).join(' · ')

  return (
    <SettingsGroup
      title={text('visTitle')}
      description={text('visDesc')}
      testId="ms-visibility"
      className="ms-group"
      actions={
        hidden.length ? (
          <Button variant="secondary" data-testid="ms-visibility-reset" onPress={() => save({ modelHidden: [] })}>
            {text('visShowAll')}
          </Button>
        ) : undefined
      }
      plain
    >
      <div className="ms-vis">
        <div className="ms-vis-bar" data-setting-id="models-visibility">
          {models.length > FILTER_AT ? (
            <SearchField aria-label={text('visFilter')} placeholder={text('visFilter')} value={query} onChange={setQuery} className="ms-vis-filter" />
          ) : null}
          <span className="ms-vis-count">{counter}</span>
        </div>
        {models.length === 0 ? <p className="ms-note">{text('visNoModels')}</p> : null}
        {models.length > 0 && shown.length === 0 ? <p className="ms-note">{text('visEmpty')}</p> : null}
        {groups.map(([provider, list]) => {
          const allHidden = list.every((m) => isFavorite(favorites, m) || isHidden(hidden, m))
          return (
            <div key={provider} className="ms-vis-group" data-testid="ms-visibility-provider">
              <div className="ms-vis-head">
                <span className="ms-vis-provider">{provider}</span>
                <Button variant="ghost" size="sm" onPress={() => setHidden(list, !allHidden)}>
                  {allHidden ? text('visShowAll') : text('visHideAll')}
                </Button>
              </div>
              {list.map((m) => {
                const favorite = isFavorite(favorites, m)
                const off = !favorite && isHidden(hidden, m)
                return (
                  <div key={modelKey(m)} className="ms-vis-row" data-hidden={off ? '1' : undefined} data-testid="ms-visibility-row">
                    <IconButton
                      size="sm"
                      variant="ghost"
                      className="ms-vis-star"
                      data-on={favorite ? '1' : undefined}
                      aria-label={`${favorite ? text('pickerUnfavoriteCurrent') : text('pickerFavoriteCurrent')}: ${m.name}`}
                      onPress={() => toggleStar(m)}
                    >
                      <Star size={13} fill={favorite ? 'currentColor' : 'none'} aria-hidden />
                    </IconButton>
                    <span className="ms-vis-name">
                      <span className="ms-vis-label">{m.name}</span>
                      {m.name !== m.id ? <code className="ms-vis-id">{m.id}</code> : null}
                    </span>
                    <Switch
                      aria-label={text('visToggle').replace('{name}', m.name)}
                      isSelected={!off}
                      isDisabled={favorite}
                      onChange={(on) => setHidden([m], !on)}
                    />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </SettingsGroup>
  )
}
