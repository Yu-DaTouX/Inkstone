import { useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { MarketPackage, MarketSearchResult } from '../../../../../shared/plugin-market'
import { Button, TextField } from '../../../ui'
import { useCapsText } from './text'
import { PackagesPanel } from './PackagesPanel'
import { InkstonePluginGroup } from './InkstonePluginGroup'
import { Empty, Entry, Group, ListSkeleton, Meta, Note, Panel, Warn } from './parts'
import { MARKET_PAGE_SIZE, marketRange } from './model'

export function MarketSection(): ReactElement {
  const t = useT()
  const text = useCapsText()
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [offset, setOffset] = useState(0)
  const [catalog, setCatalog] = useState<MarketSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState('')
  const [selectionKey, setSelectionKey] = useState(0)
  const generation = useRef(0)

  const runSearch = (nextQuery: string, nextOffset: number): void => {
    const current = ++generation.current
    setLoading(true)
    setApplied(nextQuery)
    setOffset(nextOffset)
    setCatalog(null)
    void window.yan.packages
      .search(nextQuery, nextOffset)
      .then((result) => {
        if (generation.current === current) setCatalog(result)
      })
      .catch((error: unknown) => {
        if (generation.current === current) {
          setCatalog({ ok: false, entries: [], total: 0, error: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }

  const search = (): void => {
    const next = query.trim()
    if (!next) return
    runSearch(next, 0)
  }

  const goPage = (nextOffset: number): void => {
    if (!applied) return
    runSearch(applied, nextOffset)
  }

  const choose = (source: string): void => {
    setSelected(source)
    setSelectionKey((value) => value + 1)
  }

  const total = catalog?.ok ? catalog.total : 0
  const range = marketRange(total, offset)
  const status =
    catalog?.ok === false
      ? t('market.searchError', { error: catalog.error ?? '' })
      : catalog?.ok && !catalog.entries.length && !loading
        ? t('market.empty')
        : ''

  return (
    <Panel label={t('market.title')}>
      <Note>{text('marketNoAutoNote')}</Note>

      <InkstonePluginGroup />

      <Group title={t('market.pi')} desc={t('market.piDesc')} settingId="caps-market-pi">
        <div className="caps-field">
          <TextField
            aria-label={t('market.search')}
            className="caps-field-input"
            value={query}
            onChange={setQuery}
            placeholder={t('market.search')}
            data-testid="caps-market-search"
          />
          <Button variant="primary" isDisabled={loading || !query.trim()} onPress={search} data-testid="caps-market-search-btn">
            {t('market.searchBtn')}
          </Button>
          <Button
            variant="secondary"
            onPress={() => void window.yan.browser.openExternal('https://pi.dev/packages')}
            data-testid="caps-market-catalog"
          >
            {t('pkg.catalog')}
          </Button>
        </div>

        {loading && !catalog?.entries.length ? (
          <div role="status" aria-label={t('pkg.working')}>
            <ListSkeleton rows={2} />
          </div>
        ) : null}
        {status ? (
          catalog?.ok === false ? <Warn>{status}</Warn> : <Empty>{status}</Empty>
        ) : null}

        {catalog?.ok && catalog.entries.length ? (
          <div className="caps-list" data-testid="caps-market-results" aria-busy={loading}>
            {catalog.entries.map((pkg: MarketPackage) => {
              const metaParts = [pkg.version, pkg.publisher, pkg.description]
              return (
                <Entry
                  key={pkg.name}
                  testId="caps-market-result"
                  name={pkg.name}
                  nameTitle={pkg.name}
                  meta={metaParts}
                  actions={
                    <>
                      <Button variant="secondary" onPress={() => choose(pkg.source)} data-testid="caps-market-choose">
                        {t('market.choose')}
                      </Button>
                      <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(pkg.npmUrl)}>
                        npm
                      </Button>
                      {pkg.homepage ? (
                        <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(pkg.homepage!)}>
                          {t('market.source')}
                        </Button>
                      ) : null}
                    </>
                  }
                />
              )
            })}
          </div>
        ) : null}

        {total > MARKET_PAGE_SIZE ? (
          <div className="caps-pager">
            <Button variant="secondary" isDisabled={loading || offset === 0} onPress={() => goPage(Math.max(0, offset - MARKET_PAGE_SIZE))}>
              {t('market.previous')}
            </Button>
            <Meta>
              {t('market.range', { from: range.from, to: range.to, total })}
            </Meta>
            <Button
              variant="secondary"
              isDisabled={loading || offset + MARKET_PAGE_SIZE >= total}
              onPress={() => goPage(offset + MARKET_PAGE_SIZE)}
            >
              {t('market.next')}
            </Button>
          </div>
        ) : null}
      </Group>

      <PackagesPanel mode="install" initialSource={selected} selectionKey={selectionKey} note={text('extensionsPackagesNote')} />
    </Panel>
  )
}
