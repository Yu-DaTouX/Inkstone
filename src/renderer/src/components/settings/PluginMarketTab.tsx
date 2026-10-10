import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Button, LinkButton, SettingRow, Tabs } from '../ui'
import { PackagesTab } from './PackagesTab'
import { INKSTONE_PLUGINS } from '../../../../shared/inkstone-plugins'
import type { MarketSearchResult } from '../../../../shared/plugin-market'

const PAGE = 24

/** Original links open in the system browser: the built-in browser sits under the settings modal. */
function SourceLink({ url, label }: { url: string; label?: string }): React.JSX.Element {
  return <LinkButton url={url} label={label} onOpen={href => void window.yan.browser.openExternal(href)} />
}

export function PluginMarketTab(): React.JSX.Element {
  const t = useT()
  const [page, setPage] = useState<'inkstone' | 'pi'>('inkstone')
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [offset, setOffset] = useState(0)
  const [catalog, setCatalog] = useState<MarketSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState('')
  const [selectionKey, setSelectionKey] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState('')
  const generation = useRef(0)
  const installRef = useRef<HTMLDivElement>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    if (page !== 'pi') return
    const current = ++generation.current
    setLoading(true)
    void window.yan.packages.search(applied, offset).then(result => {
      if (generation.current === current) setCatalog(result)
    }).catch(error => {
      if (generation.current === current) setCatalog({ ok: false, entries: [], total: 0, error: String(error) })
    }).finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current++; setLoading(false) }
  }, [page, applied, offset, refresh])

  const download = async (id: string): Promise<void> => {
    setExporting(true)
    setNote('')
    try {
      const result = await window.yan.packages.exportPlugin(id)
      if (!result.cancelled) setNote(result.ok ? t('market.exported', { path: result.path ?? '' }) : result.error ?? t('pkg.failed'))
    } catch { setNote(t('pkg.failed')) }
    finally { setExporting(false) }
  }

  const choose = (source: string): void => {
    setSelected(source)
    setSelectionKey(value => value + 1)
    installRef.current?.querySelector('[data-testid="pkg-install"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const total = catalog?.ok ? catalog.total : 0
  const status = catalog?.ok === false ? t('market.searchError', { error: catalog.error ?? '' })
    : catalog?.ok && !catalog.entries.length && !loading ? t('market.empty') : ''

  return <div className="ui-rows" data-testid="plugin-market">
    <Tabs label={t('market.title')} testId="market-tabs" value={page} onChange={setPage}
      items={[{ value: 'inkstone', label: t('market.ours'), testId: 'market-ours-tab' },
        { value: 'pi', label: t('market.pi'), testId: 'market-pi-tab' }]} />
    <div role="tabpanel" key={page} className="market-panel" aria-label={page === 'inkstone' ? t('market.ours') : t('market.pi')}>
      {page === 'inkstone' ? <div className="ui-rows" data-testid="market-ours">
        <div className="ui-row-desc">{t('market.oursDesc')}</div>
        {INKSTONE_PLUGINS.map(plugin => <SettingRow col ctlClassName="market-plugin-body" key={plugin.id} name={`${plugin.name} · ${plugin.version}`} desc={t(plugin.descriptionKey)}>
          <div className="ui-row-desc">{t(plugin.targetKey)}</div>
          <SourceLink url={plugin.url} label={t('market.source')} />
          <div className="pkg-install-row">
            <Button size="sm" disabled={exporting} data-testid="market-hermes-download" onClick={() => void download(plugin.id)}>
              {exporting ? t('pkg.working') : t('market.download')}
            </Button>
            <span className="ui-row-desc">{t('market.installHint')}</span>
          </div>
        </SettingRow>)}
        {note ? <div role="status" className="ui-row-desc market-note">{note}</div> : null}
      </div> : <div className="ui-rows" data-testid="market-pi">
        <div className="ui-row-desc">{t('market.piDesc')}</div>
        <form className="pkg-install-row" onSubmit={event => { event.preventDefault(); setOffset(0); setApplied(query.trim()); setRefresh(value => value + 1) }}>
          <input className="ui-input" data-testid="market-search" aria-label={t('market.search')} placeholder={t('market.search')} value={query} onChange={event => setQuery(event.target.value)} maxLength={100} />
          <Button size="sm" type="submit" disabled={loading}>{t('market.searchBtn')}</Button>
        </form>
        <div role="status" className="ui-row-desc">{loading && !catalog?.entries.length ? t('pkg.working') : status}</div>
        {catalog?.ok && catalog.entries.length ? <div className={'market-results' + (loading ? ' loading' : '')} data-testid="market-results" aria-busy={loading}>
          {catalog.entries.map((pkg, index) => <div className="market-item" key={pkg.name} style={{ '--i': Math.min(index, 8) } as React.CSSProperties}>
            <div className="market-item-main">
              <div className="pkg-item-main"><span className="pkg-name" title={pkg.name}>{pkg.name}</span><span className="pkg-ver">{pkg.version}</span></div>
              {pkg.description ? <div className="market-item-desc" title={pkg.description}>{pkg.description}</div> : null}
              <div className="market-item-links">
                {pkg.publisher ? <span className="pkg-detail-line pkg-dim">{pkg.publisher}</span> : null}
                <SourceLink url={pkg.npmUrl} />
                {pkg.homepage ? <SourceLink url={pkg.homepage} /> : null}
              </div>
            </div>
            <Button size="sm" className="market-item-action" data-testid="market-choose" onClick={() => choose(pkg.source)}>{t('market.choose')}</Button>
          </div>)}
        </div> : null}
        {total > PAGE ? <div className="pkg-install-row market-pager">
          <Button size="sm" variant="ghost" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE))}>{t('market.previous')}</Button>
          <span className="ui-row-desc">{t('market.range', { from: offset + 1, to: Math.min(total, offset + PAGE), total })}</span>
          <Button size="sm" variant="ghost" disabled={loading || offset + PAGE >= total} onClick={() => setOffset(value => value + PAGE)}>{t('market.next')}</Button>
        </div> : null}
        <div ref={installRef}><PackagesTab selectedSource={selected} selectionKey={selectionKey} showBuiltin={false} /></div>
      </div>}
    </div>
  </div>
}
