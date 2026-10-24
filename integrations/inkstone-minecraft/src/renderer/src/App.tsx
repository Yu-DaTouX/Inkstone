import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { SegmentedControl } from '@yan/ui/SegmentedControl'
import type { LauncherSettings, LaunchStatus } from '../../shared/api.ts'
import { DownloadPage } from './DownloadPage.tsx'
import { DevPage } from './DevPage.tsx'
import { LaunchPage } from './LaunchPage.tsx'
import { LogSheet, useGameLogs } from './LogSheet.tsx'
import { SettingsPage, type SettingsSection } from './SettingsPage.tsx'
import { TaskIndicator } from './TaskIndicator.tsx'
import { VersionPage } from './VersionPage.tsx'

type Page = 'launch' | 'download' | 'dev' | 'settings'

interface VersionRoute {
  folder: string
  id: string
}

const PAGES = [
  { value: 'launch', label: '启动' },
  { value: 'download', label: '下载' },
  { value: 'dev', label: '开发' },
  { value: 'settings', label: '设置' }
] as const

export function App(): ReactElement {
  const [page, setPage] = useState<Page>('launch')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('accounts')
  const [version, setVersion] = useState<VersionRoute | null>(null)
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [status, setStatus] = useState<LaunchStatus | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const logs = useGameLogs(status)

  useEffect(() => {
    void window.craft.settings().then((loaded) => {
      setSettings(loaded)
      if (loaded.folders.length === 0 && loaded.importedFromPclAt === null) {
        setSettingsSection('import')
        setPage('settings')
      }
    })
    void window.craft.status().then(setStatus)
    return window.craft.onStatus(setStatus)
  }, [])

  useEffect(() => {
    if (status?.state === 'failed' && !status.crashId) setLogOpen(true)
  }, [status?.state])

  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  const apply = useCallback(async (next: Promise<LauncherSettings>): Promise<void> => {
    setSettings(await next)
  }, [])

  const openSettings = (section: SettingsSection): void => {
    setSettingsSection(section)
    setPage('settings')
  }

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className="shell__brand">
          <span className="shell__mark" aria-hidden="true" />
          <span className="shell__name">Inkstone Minecraft</span>
        </div>
        <SegmentedControl
          label="页面"
          value={page}
          options={PAGES}
          onChange={(next) => {
            setPage(next)
            if (next === 'launch') setVersion(null)
          }}
          className="shell__nav"
        />
        <div className="shell__tools">
          <TaskIndicator />
        </div>
      </header>
      <main className="shell__page">
        {!settings ? (
          <p className="shell__loading">正在读取设置…</p>
        ) : page === 'launch' && version ? (
          <VersionPage
            key={`${version.folder}|${version.id}`}
            folder={version.folder}
            versionId={version.id}
            settings={settings}
            onBack={() => setVersion(null)}
            onOpenLogs={() => setLogOpen(true)}
            onRenamed={(id) => setVersion({ folder: version.folder, id })}
          />
        ) : page === 'launch' ? (
          <LaunchPage
            settings={settings}
            status={status}
            apply={apply}
            onImport={() => openSettings('import')}
            onManage={(folder, id) => setVersion({ folder, id })}
            onOpenLogs={() => setLogOpen(true)}
            onOpenSettings={openSettings}
          />
        ) : page === 'download' ? (
          <DownloadPage />
        ) : page === 'dev' ? (
          <DevPage />
        ) : (
          <SettingsPage settings={settings} apply={apply} section={settingsSection} onSection={setSettingsSection} onImported={() => setPage('launch')} />
        )}
      </main>
      <LogSheet open={logOpen} logs={logs} folder={settings?.selectedFolder ?? null} versionId={status?.versionId ?? settings?.selectedVersion ?? null} onClose={() => setLogOpen(false)} />
    </div>
  )
}
