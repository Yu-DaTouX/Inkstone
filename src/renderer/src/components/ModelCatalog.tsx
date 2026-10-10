import { useEffect, useMemo, useRef, useState } from 'react'
import { modelKey, type ModelChoice } from '../../../shared/model-selection'
import { modelErrorText } from '../../../shared/model-errors'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Icon } from '../icons/Icon'
import { Button, Input } from './ui'
import { ChoiceSelect } from './ui/ChoiceSelect'

/** Version order is local catalog metadata, not a guessed release date. */
function newestFirst(a: ModelChoice, b: ModelChoice): number {
  const family = (m: ModelChoice) => m.id.match(/^[a-z]+/i)?.[0] ?? m.id
  const group = a.provider.localeCompare(b.provider) || family(a).localeCompare(family(b))
  if (group) return group
  const version = (m: ModelChoice) => (m.id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? '').split(/[.-]/).map(Number)
  const av = version(a), bv = version(b)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const difference = (bv[i] ?? 0) - (av[i] ?? 0)
    if (difference) return difference
  }
  return (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true }) || modelKey(a).localeCompare(modelKey(b))
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  return `${Number((tokens / 1_000).toFixed(1))}K`
}

/** Shared model browsing; filtering and favorites never select a runtime model. */
export function ModelCatalog({ current, onSelect, compact = false, needsAuth = () => false }: {
  current?: ModelChoice; onSelect(model: ModelChoice): Promise<boolean>; compact?: boolean
  needsAuth?(provider: string): boolean
}) {
  const t = useT()
  const models = useStore(s => s.models)
  const favorites = useStore(s => s.settings?.modelFavorites) ?? []
  const patch = useStore(s => s.patchSettings)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState(current?.provider ?? '')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const providerOrder = useStore(s => s.settings?.modelProviderOrder) ?? []
  /* 键盘移动光标才把行滚进视野；鼠标悬停移动光标时不滚，免得列表跟着鼠标跳 */
  const keyboardCursor = useRef(false)
  const favoriteKeys = new Set(favorites.map(modelKey))
  const available = new Set(models.map(modelKey))
  /* 供应商按用户拖动的顺序；没排过的按字母接在后面 */
  const providerRank = (p: string) => { const i = providerOrder.indexOf(p); return i < 0 ? providerOrder.length : i }
  const providers = [...new Set([...models, ...favorites, ...(current ? [current] : [])].map(m => m.provider))]
    .sort((a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b))
  const rows = useMemo(() => {
    const byKey = new Map<string, ModelChoice>(models.map(m => [modelKey(m), m]))
    for (const m of favorites) if (!byKey.has(modelKey(m))) byKey.set(modelKey(m), m)
    const q = query.trim().toLowerCase(), stars = new Set(favorites.map(modelKey))
    const rank = (p: string) => { const i = providerOrder.indexOf(p); return i < 0 ? providerOrder.length : i }
    /* 收藏页显示全部收藏，不受供应商筛选限制 */
    return [...byKey.values()].filter(m => (favoriteOnly || !provider || m.provider === provider)
      && (!favoriteOnly || stars.has(modelKey(m)))
      && (!q || `${m.name ?? ''} ${m.id} ${m.provider}`.toLowerCase().includes(q)))
      .sort((a, b) => rank(a.provider) - rank(b.provider) || newestFirst(a, b))
  }, [models, favorites, query, provider, favoriteOnly, providerOrder])
  useEffect(() => { const timer = window.setTimeout(() => search.current?.focus(), 0); return () => clearTimeout(timer) }, [])
  useEffect(() => { setCursor(0); if (list.current) list.current.scrollTop = 0 }, [query, provider, favoriteOnly])
  useEffect(() => {
    if (!keyboardCursor.current) return
    keyboardCursor.current = false
    list.current?.querySelector('[data-cursor="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  const moveCursor = (next: (i: number) => number) => { keyboardCursor.current = true; setCursor(next) }
  const select = async (model: ModelChoice) => {
    if (pending || !available.has(modelKey(model))) return
    setPending(true); setError('')
    try { if (!(await onSelect(model))) setError(t('models.selectFailed')) }
    catch (e) { setError(modelErrorText(e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')) }
    finally { setPending(false) }
  }
  const toggleFavorite = async (model: ModelChoice) => {
    if (pending) return
    setPending(true); setError('')
    try {
      const saved = useStore.getState().settings?.modelFavorites ?? []
      const key = modelKey(model)
      await patch({ modelFavorites: saved.some(m => modelKey(m) === key)
        ? saved.filter(m => modelKey(m) !== key) : [...saved, { provider: model.provider, id: model.id, name: model.name }] })
    } catch (e) { setError(modelErrorText(e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')) }
    finally { setPending(false) }
  }
  return <div className={`model-catalog${compact ? ' compact' : ''}`} data-testid="model-catalog" aria-busy={pending}>
    <Input ref={search} value={query} aria-label={t('picker.searchModel')} placeholder={t('picker.searchModel')}
      data-testid="model-search" onChange={e => setQuery(e.target.value)} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); moveCursor(i => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
        } else if (e.key === 'Enter') { e.preventDefault(); if (rows[cursor]) void select(rows[cursor]) }
        else if (e.key === 'PageDown' || e.key === 'PageUp') {
          e.preventDefault(); moveCursor(i => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'PageDown' ? 5 : -5))))
        }
      }} />
    <div className="model-filters">
      <Button size="sm" variant="ghost" active={!favoriteOnly} data-testid="models-all" onClick={() => setFavoriteOnly(false)}>{t('models.all')}</Button>
      <Button size="sm" variant="ghost" active={favoriteOnly} data-testid="models-favorites" onClick={() => setFavoriteOnly(true)}>★ {t('models.favorites')}</Button>
      <span className="model-count" data-testid="models-count">{t('models.count', { n: rows.length })}</span>
      <ChoiceSelect value={provider} label={t('models.provider')} testId="models-provider" className="model-provider"
        disabled={favoriteOnly} reorderHint={t('models.providerReorder')}
        onReorder={order => { void patch({ modelProviderOrder: order }).catch(e => setError(modelErrorText(e))) }}
        onChange={setProvider} options={[{ value: '', label: t('models.allProviders') }, ...providers.map(p => ({ value: p, label: p, reorderable: true }))]} />
    </div>
    <div ref={list} className="mt-list model-rows" role="group" aria-label={t('models.all')}>
      {rows.map((m, i) => {
        const key = modelKey(m), on = !!current && key === modelKey(current), ready = available.has(key)
        const info = models.find(model => modelKey(model) === key)
        const starred = favoriteKeys.has(key)
        const context = info?.contextWindow && info.contextWindowStatus !== 'unknown' ? contextLabel(info.contextWindow) : ''
        /* 名称里已带容量（如「Opus 5.5 1M」）就不再重复 */
        const showContext = !!context && !new RegExp(`(^|[^\\w.])${context.replace('.', '\\.')}($|[^\\w.])`, 'i').test(m.name || m.id)
        const showProvider = favoriteOnly || !provider
        /* 整行一个悬停底：鼠标与键盘共用同一个落点，只有落点行和当前模型有底色 */
        return <div className="model-row" key={key} data-current={on ? '1' : '0'} data-cursor={i === cursor ? '1' : '0'}
          data-starred={starred ? '1' : '0'} data-ready={ready ? '1' : '0'}
          onMouseMove={() => { if (i !== cursor) setCursor(i) }}>
          <Button size="sm" variant="ghost" active={on} className="model-option" disabled={pending || !ready}
            data-testid="model-option" data-model-id={m.id} data-provider={m.provider} data-current={on ? '1' : '0'} data-cursor={i === cursor ? '1' : '0'}
            title={`${m.name || m.id}\n${m.provider} / ${m.id}`} onClick={() => void select(m)}>
            <span className="model-row-check" aria-hidden>{on ? <Icon name="check" size={12} /> : null}</span>
            <span className="model-row-text">
              <span className="model-row-name">{m.name || m.id}</span>
              {/* 单行：名称在左，右侧只放区分得开的信息 —— 已按供应商筛选时不重复供应商；推理能力由下方档位表达 */}
              <span className="model-row-id">
                {showProvider ? <span>{m.provider}</span> : null}
                {showContext ? <span>{context}</span> : null}
                {info?.input?.includes('image') && info.inputStatus !== 'unknown' ? <span>{t('picker.image')}</span> : null}
                {!ready ? <span className="model-row-warn">{t('models.unavailable')}</span>
                  : needsAuth(m.provider) ? <span className="model-row-warn">{t('picker.needsAuth')}</span> : null}
              </span>
            </span>
          </Button>
          <Button size="sm" variant="ghost" className="model-favorite" disabled={pending} active={starred} data-testid="model-favorite"
            aria-label={t(starred ? 'models.unfavorite' : 'models.favorite', { name: m.name || m.id })}
            onClick={() => void toggleFavorite(m)}>{starred ? '★' : '☆'}</Button>
        </div>
      })}
      {!rows.length ? <p className="ui-row-desc">{t(favoriteOnly ? 'models.noFavorites' : models.length ? 'picker.noMatch' : 'picker.noModels')}</p> : null}
    </div>
    {error ? <p className="ui-row-desc" role="alert" data-testid="models-error">{error}</p> : null}
  </div>
}
