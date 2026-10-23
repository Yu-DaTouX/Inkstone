import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import {
  BUILTIN_PLUGIN_CATALOG,
  pluginText,
  type PluginCatalogEntry,
  type PluginCatalogView
} from '../../../../../shared/plugin-catalog'
import { Button } from '../../../ui'
import { DesktopPetRow } from './DesktopPetRow'
import { Entry, Group } from './parts'

function catalogDate(timestamp: number | null, lang: string): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function InkstonePluginGroup(): ReactElement {
  const { t, lang } = useI18n()
  const [catalog, setCatalog] = useState<PluginCatalogView>(BUILTIN_PLUGIN_CATALOG)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState('')
  const [note, setNote] = useState('')
  const alive = useRef(true)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    if (refresh) setRefreshing(true)
    try {
      const next = await window.yan.packages.catalog(refresh)
      if (alive.current) setCatalog(next)
    } catch {
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load(false)
    return () => {
      alive.current = false
    }
  }, [load])

  const run = async (entry: PluginCatalogEntry): Promise<void> => {
    if (entry.kind !== 'export' && entry.kind !== 'mcp') return
    setExporting(entry.id)
    setNote('')
    try {
      const result = entry.kind === 'mcp' ? await window.yan.packages.addMcp(entry.id) : await window.yan.packages.exportPlugin(entry.id)
      const done = entry.kind === 'mcp' ? (result.existed ? 'market.mcpExisted' : 'market.mcpAdded') : 'market.exported'
      if (!result.cancelled) setNote(result.ok ? t(done, { path: result.path ?? '' }) : (result.error ?? t('pkg.failed')))
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : t('pkg.failed'))
    } finally {
      setExporting('')
    }
  }

  const sourceLabel =
    catalog.source === 'remote'
      ? t('market.catalogRemote', { time: catalogDate(catalog.fetchedAt, lang) })
      : catalog.source === 'cache'
        ? t('market.catalogCache', { time: catalogDate(catalog.fetchedAt, lang) })
        : t('market.catalogBuiltin')

  return (
    <Group
      title={t('market.ours')}
      desc={t('market.oursDesc')}
      settingId="caps-market-inkstone"
      actions={
        <Button variant="ghost" isDisabled={refreshing} onPress={() => void load(true)} data-testid="caps-market-catalog-refresh">
          {refreshing ? t('pkg.working') : t('market.catalogRefresh')}
        </Button>
      }
    >
      <p className="caps-result" data-testid="caps-market-catalog-source">
        {sourceLabel}
      </p>
      <div className="caps-list" data-testid="caps-market-inkstone">
        {catalog.plugins.map((entry) => {
          const copy = pluginText(entry, lang)
          if (entry.kind === 'pet') return <DesktopPetRow key={entry.id} entry={entry} copy={copy} />
          const metaParts = [copy.desc, copy.target, copy.hint]
          return (
            <Entry
              key={entry.id}
              testId="caps-market-plugin"
              name={`${copy.name ?? entry.name}${entry.version ? ` · ${entry.version}` : ''}`}
              meta={metaParts}
              metaTitle={metaParts.filter(Boolean).join(' · ')}
              actions={
                <>
                  {entry.kind === 'export' || entry.kind === 'mcp' ? (
                    <Button
                      variant="secondary"
                      isDisabled={exporting === entry.id}
                      onPress={() => void run(entry)}
                      data-testid={entry.kind === 'mcp' ? `caps-market-${entry.id}-mcp` : 'caps-market-download'}
                    >
                      {exporting === entry.id ? t('pkg.working') : t(entry.kind === 'mcp' ? 'market.addMcp' : 'market.download')}
                    </Button>
                  ) : null}
                  <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(entry.url)} data-testid="caps-market-source">
                    {t('market.source')}
                  </Button>
                </>
              }
            />
          )
        })}
      </div>
      {note ? (
        <p className="caps-result" role="status" data-testid="caps-market-note">
          {note}
        </p>
      ) : null}
    </Group>
  )
}
