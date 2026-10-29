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
import { MinecraftPluginRow } from './MinecraftPluginRow'
import { Entry, Group } from './parts'
import { useConfirm } from './confirm'

function BundledPluginRow({ entry }: { entry: PluginCatalogEntry }): ReactElement {
  const { t, lang } = useI18n()
  const confirm = useConfirm()
  const copy = pluginText(entry, lang)
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    void window.yan.plugins.action(entry.id, 'status').then(result => {
      if (alive) { setInstalled(result.installed === true); if (!result.ok) setNote(result.error ?? t('pkg.failed')) }
    }).catch(error => { if (alive) setNote(String(error)) })
    return () => { alive = false }
  }, [entry.id, t])
  const run = async (action: 'install' | 'remove'): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.yan.plugins.action(entry.id, action)
      if (result.ok) setInstalled(result.installed === true)
      setNote(result.ok ? copy.target ?? '' : result.error ?? t('pkg.failed'))
    } catch (error) { setNote(String(error)) }
    finally { setBusy(false) }
  }
  const choose = (action: 'install' | 'remove'): void => {
    void confirm({
      title: t(action === 'install' ? 'pet.install' : 'pet.uninstall'),
      body: copy.desc, detail: copy.target ?? '', confirmLabel: t(action === 'install' ? 'pet.install' : 'pet.uninstall'),
      tone: action === 'remove' ? 'danger' : 'default', action: () => run(action)
    })
  }
  const statusLabel = installed ? t('pkg.installed') : t('ocp.statusMissing')
  return <Entry name={`${copy.name ?? entry.name}${entry.version ? ` · ${entry.version}` : ''}`} meta={[statusLabel, copy.desc, copy.target, copy.hint, note]} testId={`caps-market-${entry.id}`}
    actions={<>
      <Button variant="secondary" isDisabled={busy} onPress={() => choose('install')}>{busy ? t('pkg.working') : t(installed ? 'pet.reinstall' : 'pet.install')}</Button>
      {installed ? <Button variant="danger" isDisabled={busy} onPress={() => choose('remove')}>{t('pet.uninstall')}</Button> : null}
      <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(entry.url)}>{t('market.source')}</Button>
    </>} />
}

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
          if (entry.id === 'desktop-pet' && (entry.kind === 'pet' || entry.kind === 'bundled')) return <DesktopPetRow key={entry.id} entry={entry} copy={copy} />
          if (entry.kind === 'bundled') return <BundledPluginRow key={entry.id} entry={entry} />
          if (entry.id === 'inkstone-minecraft') return <MinecraftPluginRow key={entry.id} entry={entry} copy={copy} />
          const metaParts = [copy.desc, copy.target, copy.hint]
          return (
            <Entry
              key={entry.id}
              testId="caps-market-plugin"
              name={`${copy.name ?? entry.name}${entry.version ? ` · ${entry.version}` : ''}`}
              meta={metaParts}
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
