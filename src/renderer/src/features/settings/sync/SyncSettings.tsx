import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { Badge, Button, Notice } from '../../../ui'
import {
  AUTO_SYNC_INTERVAL_MS,
  type SyncBridge,
  type SyncConflictView,
  type SyncMode,
  type SyncResolution,
  type SyncStatusView
} from '../../../../../shared/sync'
import { Segmented, SettingsGroup, SettingsRow } from '../root/controls'
import { requestSettingReveal } from '../search/search-model'
import { syncBridge } from './bridge'
import { syncText, type SyncText } from './text'

export interface SyncMessage {
  scope: 'sync' | 'conflicts'
  tone: 'info' | 'fail'
  text: string
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] !== undefined ? String(values[key]) : match))
}

function formatTime(ms: number | undefined, lang: string): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Date(ms).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN')
  } catch {
    return '—'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SyncPanel {
  bridge: SyncBridge | null
  text: SyncText
  lang: string
  status: SyncStatusView | null
  conflicts: SyncConflictView[]
  busy: string | null
  message: SyncMessage | null
  configured: boolean
  chooseFolder: () => void
  clearFolder: () => void
  changeMode: (mode: SyncMode) => void
  syncNow: () => void
  resolve: (id: string, resolution: SyncResolution) => void
}

export function useSyncPanel(): SyncPanel {
  const { lang } = useI18n()
  const text = syncText(lang)
  const bridge = useMemo(() => syncBridge(), [])
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([])
  const [busy, setBusy] = useState<string | null>('load')
  const [message, setMessage] = useState<SyncMessage | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    try {
      setStatus(await bridge.status())
      setConflicts(await bridge.conflicts())
    } catch (error) {
      setMessage({ scope: 'sync', tone: 'fail', text: `${text.loadFailed} ${describe(error)}` })
    }
  }, [bridge, text])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (bridge) await refresh()
      if (alive) setBusy(null)
    }
    void load()
    return () => {
      alive = false
    }
  }, [bridge, refresh])

  const configured = Boolean(status?.syncRoot)

  const perform = (key: string, scope: SyncMessage['scope'], failure: string, action: (sync: SyncBridge) => Promise<void>): void => {
    if (!bridge || busy) return
    setBusy(key)
    setMessage(null)
    void action(bridge)
      .catch((error) => setMessage({ scope, tone: 'fail', text: `${failure} ${describe(error)}` }))
      .finally(() => setBusy(null))
  }

  const chooseFolder = (): void =>
    perform('folder', 'sync', text.configureFailed, async (sync) => {
      const result = await sync.configure()
      if (result.ok) await refresh()
      else if (result.cancelled) setMessage({ scope: 'sync', tone: 'info', text: text.cancelled })
      else setMessage({ scope: 'sync', tone: 'fail', text: result.error ?? text.configureFailed })
    })

  const clearFolder = (): void =>
    perform('folder', 'sync', text.configureFailed, async (sync) => {
      const result = await sync.configure(null)
      if (result.ok) await refresh()
      else setMessage({ scope: 'sync', tone: 'fail', text: result.error ?? text.configureFailed })
    })

  const changeMode = (mode: SyncMode): void => {
    if (mode === status?.mode) return
    perform('mode', 'sync', text.modeFailed, async (sync) => {
      const result = await sync.setMode(mode)
      if (result.ok) await refresh()
      else setMessage({ scope: 'sync', tone: 'fail', text: result.error ?? text.modeFailed })
    })
  }

  const syncNow = (): void => {
    if (!configured) return
    perform('sync', 'sync', text.syncFailed, async (sync) => {
      const result = await sync.now()
      if (result.ok) {
        setMessage({
          scope: 'sync',
          tone: 'info',
          text: fillTemplate(text.syncDone, {
            pushed: result.pushed,
            pulled: result.pulled,
            conflicts: result.conflicts,
            skipped: result.skipped
          })
        })
      } else {
        setMessage({ scope: 'sync', tone: 'fail', text: result.error ?? text.syncFailed })
      }
      await refresh()
    })
  }

  const resolve = (id: string, resolution: SyncResolution): void =>
    perform(id, 'conflicts', text.resolveFailed, async (sync) => {
      const result = await sync.resolve(id, resolution)
      if (!result.ok) setMessage({ scope: 'conflicts', tone: 'fail', text: result.error ?? text.resolveFailed })
      await refresh()
    })

  return { bridge, text, lang, status, conflicts, busy, message, configured, chooseFolder, clearFolder, changeMode, syncNow, resolve }
}

function SyncMessageLine({ message, scope }: { message: SyncMessage | null; scope: SyncMessage['scope'] }): ReactElement | null {
  if (!message || message.scope !== scope) return null
  return (
    <Notice tone={message.tone} compact className="dd-message">
      {message.text}
    </Notice>
  )
}

export function SyncGroup({ panel }: { panel: SyncPanel }): ReactElement {
  const { bridge, text, lang, status, conflicts, busy, message, configured } = panel
  if (!bridge) {
    return (
      <SettingsGroup label={text.folder}>
        <SettingsRow settingId="data-sync-folder" label={text.folder} description={text.bridgeMissing}>
          {null}
        </SettingsRow>
      </SettingsGroup>
    )
  }
  const last = status?.lastSync
  const errors = last?.errors ?? []
  const mode: SyncMode = status?.mode ?? 'manual'
  const intervalHours = Math.max(1, Math.round((status?.autoIntervalMs ?? AUTO_SYNC_INTERVAL_MS) / 3_600_000))
  const modeHint = !configured
    ? text.modeNeedsFolder
    : mode === 'auto'
      ? fillTemplate(text.modeAutoHint, { hours: intervalHours })
      : text.modeManualHint

  return (
    <SettingsGroup label={text.folder}>
      <SettingsRow block settingId="data-sync-folder" label={text.folder} description={text.folderRecommend}>
        <div className="settings-data" data-testid="v3-sync-folder">
          <span className="settings-path" data-testid="v3-sync-folder-path" title={status?.syncRoot ?? ''}>
            {status?.syncRoot ?? text.folderUnset}
          </span>
          <div className="settings-actions">
            <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={panel.chooseFolder}>
              {text.folderPick}
            </Button>
            {configured ? (
              <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={panel.clearFolder}>
                {text.folderClear}
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      <SettingsRow settingId="data-sync-mode" label={text.modeTitle} description={modeHint}>
        <Segmented<SyncMode>
          label={text.modeTitle}
          value={mode}
          disabled={busy !== null || !configured}
          onChange={panel.changeMode}
          options={[
            { value: 'manual', label: text.modeManual, testId: 'v3-sync-mode-manual' },
            { value: 'auto', label: text.modeAuto, testId: 'v3-sync-mode-auto' }
          ]}
        />
      </SettingsRow>

      <SettingsRow
        settingId="data-sync-now"
        label={text.syncNow}
        description={
          <span className="dd-lines" data-testid="v3-sync-last">
            <span>
              {last
                ? fillTemplate(text.lastLine, { time: formatTime(last.at, lang), result: last.ok ? text.lastDone : text.lastFailed })
                : text.lastNever}
            </span>
            {last ? (
              <span>
                {fillTemplate(text.resultPushed, { n: last.pushed })} · {fillTemplate(text.resultPulled, { n: last.pulled })} ·{' '}
                {fillTemplate(text.resultConflicts, { n: last.conflicts })} · {fillTemplate(text.resultSkipped, { n: last.skipped })}
              </span>
            ) : null}
            {errors.map((line, index) => (
              <span key={`${index}-${line}`} className="settings-row__desc--error">
                {line}
              </span>
            ))}
            {conflicts.length > 0 ? <span>{fillTemplate(text.conflictsPending, { n: conflicts.length })}</span> : null}
          </span>
        }
      >
        {conflicts.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            onPress={() => requestSettingReveal({ section: 'data', id: 'data-sync-conflicts' })}
          >
            {text.conflictsReview}
          </Button>
        ) : null}
        <Button size="sm" variant="primary" isDisabled={busy !== null || !configured} onPress={panel.syncNow}>
          {busy === 'sync' ? text.syncing : text.syncNow}
        </Button>
      </SettingsRow>

      <SettingsRow
        settingId="data-sync-scope"
        label={text.contentTitle}
        description={
          <>
            {text.contentList}
            <br />
            {text.credentialNote}
          </>
        }
      >
        {null}
      </SettingsRow>

      <SyncMessageLine message={message} scope="sync" />
    </SettingsGroup>
  )
}

export function SyncConflictsGroup({ panel }: { panel: SyncPanel }): ReactElement | null {
  const { bridge, text, lang, conflicts, busy, message } = panel
  if (!bridge) return null
  return (
    <SettingsGroup label={text.conflictsTitle}>
      <SettingsRow block settingId="data-sync-conflicts" label={text.conflictsTitle} description={text.conflictsHint}>
        {conflicts.length === 0 ? (
          <p className="settings-row__desc" data-testid="v3-sync-conflicts-none">
            {text.conflictsNone}
          </p>
        ) : (
          <ul className="dd-conflicts" data-testid="v3-sync-conflicts">
            {conflicts.map((conflict) => (
              <li className="settings-device dd-conflict" key={conflict.id} data-testid={`v3-sync-conflict-${conflict.id}`}>
                <div className="dd-conflict__head">
                  <Badge tone="ask">{text.kinds[conflict.kind]}</Badge>
                  <span className="settings-device__name dd-conflict__key" title={conflict.key}>
                    {conflict.key}
                  </span>
                </div>
                <div className="dd-conflict__sides">
                  <div className="dd-conflict__side">
                    <span className="settings-value">
                      {text.localSide}
                      {conflict.localDeviceName ? ` · ${conflict.localDeviceName}` : ''}
                    </span>
                    <span className="settings-row__desc">{formatTime(conflict.localModifiedAt, lang)}</span>
                    <p className="settings-path dd-conflict__preview">{conflict.localPreview ?? text.noLocal}</p>
                  </div>
                  <div className="dd-conflict__side">
                    <span className="settings-value">{fillTemplate(text.remoteSide, { device: conflict.remoteDeviceName })}</span>
                    <span className="settings-row__desc">{formatTime(conflict.remoteModifiedAt, lang)}</span>
                    <p className="settings-path dd-conflict__preview">{conflict.remotePreview ?? text.noLocal}</p>
                  </div>
                </div>
                <div className="settings-actions">
                  <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => panel.resolve(conflict.id, 'local')}>
                    {text.keepLocal}
                  </Button>
                  <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => panel.resolve(conflict.id, 'remote')}>
                    {text.keepRemote}
                  </Button>
                  <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => panel.resolve(conflict.id, 'both')}>
                    {text.keepBoth}
                  </Button>
                  {busy === conflict.id ? <span className="settings-row__desc">{text.resolving}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
      <SyncMessageLine message={message} scope="conflicts" />
    </SettingsGroup>
  )
}
