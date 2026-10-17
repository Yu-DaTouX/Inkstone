import { useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { INKSTONE_PLUGINS } from '../../../../../shared/inkstone-plugins'
import type { MarketPackage, MarketSearchResult } from '../../../../../shared/plugin-market'
import { Button, TextField } from '../../../ui'
import { useCapsText } from './text'
import { PackagesPanel } from './PackagesPanel'
import { Actions, Empty, Group, Item, ItemHead, Meta, Note, Panel, Warn } from './parts'
import { MARKET_PAGE_SIZE, marketRange } from './model'
import { OpenCodeProxyRow } from './OpenCodeProxyRow'
import { CodegraphStatusRow } from './CodegraphStatusRow'

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
  const [exporting, setExporting] = useState('')
  const [note, setNote] = useState('')
  const generation = useRef(0)

  const runSearch = (nextQuery: string, nextOffset: number): void => {
    const current = ++generation.current
    setLoading(true)
    setApplied(nextQuery)
    setOffset(nextOffset)
    setCatalog(null)
    setNote('')
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

  const download = async (id: string, action: 'export' | 'mcp'): Promise<void> => {
    setExporting(id)
    setNote('')
    try {
      const result = action === 'mcp' ? await window.yan.packages.addMcp(id) : await window.yan.packages.exportPlugin(id)
      const done = action === 'mcp' ? (result.existed ? 'market.mcpExisted' : 'market.mcpAdded') : 'market.exported'
      if (!result.cancelled) setNote(result.ok ? t(done, { path: result.path ?? '' }) : (result.error ?? t('pkg.failed')))
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : t('pkg.failed'))
    } finally {
      setExporting('')
    }
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

      <Group title={t('market.ours')} desc={t('market.oursDesc')}>
        <div className="caps-list" data-testid="caps-market-inkstone">
          {INKSTONE_PLUGINS.map((plugin) =>
            plugin.action === 'proxy' ? (
              <OpenCodeProxyRow key={plugin.id} />
            ) : (
              <Item key={plugin.id} testId="caps-market-plugin">
                <ItemHead>
                  <span className="caps-name">
                    {plugin.name} · {plugin.version}
                  </span>
                  <span className="caps-spacer" />
                  <Actions>
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={exporting === plugin.id}
                      onPress={() => void download(plugin.id, plugin.action)}
                      data-testid={plugin.action === 'mcp' ? `caps-market-${plugin.id}-mcp` : 'caps-market-download'}
                    >
                      {exporting === plugin.id ? t('pkg.working') : t(plugin.action === 'mcp' ? 'market.addMcp' : 'market.download')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => void window.yan.browser.openExternal(plugin.url)}
                      data-testid="caps-market-source"
                    >
                      {t('market.source')}
                    </Button>
                  </Actions>
                </ItemHead>
                <Meta>{t(plugin.descriptionKey)}</Meta>
                <Meta>{t(plugin.targetKey)}</Meta>
                <Meta>{t(plugin.hintKey)}</Meta>
                {plugin.id === 'codegraph' ? <CodegraphStatusRow refreshKey={note} /> : null}
              </Item>
            )
          )}
        </div>
        {note ? (
          <p className="caps-result" role="status" data-testid="caps-market-note">
            {note}
          </p>
        ) : null}
      </Group>

      <Group title={t('market.pi')} desc={t('market.piDesc')}>
        <div className="caps-field">
          <TextField
            aria-label={t('market.search')}
            className="caps-field-input"
            value={query}
            onChange={setQuery}
            placeholder={t('market.search')}
            data-testid="caps-market-search"
          />
          <Button size="sm" variant="primary" isDisabled={loading || !query.trim()} onPress={search} data-testid="caps-market-search-btn">
            {t('market.searchBtn')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => void window.yan.browser.open('https://pi.dev/packages')}
            data-testid="caps-market-catalog"
          >
            {t('pkg.catalog')}
          </Button>
        </div>

        {loading && !catalog?.entries.length ? <p className="caps-meta" role="status">{t('pkg.working')}</p> : null}
        {status ? (
          catalog?.ok === false ? <Warn>{status}</Warn> : <Empty>{status}</Empty>
        ) : null}

        {catalog?.ok && catalog.entries.length ? (
          <div className="caps-list" data-testid="caps-market-results" aria-busy={loading}>
            {catalog.entries.map((pkg: MarketPackage) => (
              <Item key={pkg.name} testId="caps-market-result">
                <ItemHead>
                  <span className="caps-name" title={pkg.name}>
                    {pkg.name}
                  </span>
                  <span className="caps-tag">{pkg.version}</span>
                  <span className="caps-spacer" />
                  <Actions>
                    <Button size="sm" variant="secondary" onPress={() => choose(pkg.source)} data-testid="caps-market-choose">
                      {t('market.choose')}
                    </Button>
                  </Actions>
                </ItemHead>
                {pkg.description ? <Meta title={pkg.description}>{pkg.description}</Meta> : null}
                {pkg.publisher ? <Meta>{pkg.publisher}</Meta> : null}
                <Actions>
                  <Button size="sm" variant="ghost" onPress={() => void window.yan.browser.openExternal(pkg.npmUrl)}>
                    npm
                  </Button>
                  {pkg.homepage ? (
                    <Button size="sm" variant="ghost" onPress={() => void window.yan.browser.openExternal(pkg.homepage!)}>
                      {t('market.source')}
                    </Button>
                  ) : null}
                </Actions>
              </Item>
            ))}
          </div>
        ) : null}

        {total > MARKET_PAGE_SIZE ? (
          <div className="caps-pager">
            <Button size="sm" variant="ghost" isDisabled={loading || offset === 0} onPress={() => goPage(Math.max(0, offset - MARKET_PAGE_SIZE))}>
              {t('market.previous')}
            </Button>
            <Meta>
              {t('market.range', { from: range.from, to: range.to, total })}
            </Meta>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={loading || offset + MARKET_PAGE_SIZE >= total}
              onPress={() => goPage(offset + MARKET_PAGE_SIZE)}
            >
              {t('market.next')}
            </Button>
          </div>
        ) : null}
      </Group>

      <PackagesPanel initialSource={selected} selectionKey={selectionKey} showBuiltin={false} />
    </Panel>
  )
}
