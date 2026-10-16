import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { Badge, Button, Separator } from '../../../ui'
import type { SyncConflictView, SyncResolution, SyncStatusView } from '../../../../../shared/sync'
import { syncBridge } from './bridge'
import { syncText } from './text'
import './sync.css'

interface Message {
  tone: 'info' | 'error'
  text: string
}

function fill(template: string, values: Record<string, string | number>): string {
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

export function SyncSettings(): ReactElement {
  const { lang } = useI18n()
  const text = syncText(lang)
  const bridge = useMemo(() => syncBridge(), [])
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([])
  const [busy, setBusy] = useState<string | null>('load')
  const [message, setMessage] = useState<Message | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    try {
      const next = await bridge.status()
      setStatus(next)
      setConflicts(await bridge.conflicts())
    } catch (error) {
      setMessage({ tone: 'error', text: `${text.loadFailed} ${describe(error)}` })
    }
  }, [bridge, text])

  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      if (!bridge) {
        if (alive) setBusy(null)
        return
      }
      await refresh()
      if (alive) setBusy(null)
    }
    void run()
    return () => {
      alive = false
    }
  }, [bridge, refresh])

  const configured = Boolean(status?.syncRoot)

  const chooseFolder = async (): Promise<void> => {
    if (!bridge || busy) return
    setBusy('folder')
    setMessage(null)
    try {
      const result = await bridge.configure()
      if (result.ok) await refresh()
      else if (result.cancelled) setMessage({ tone: 'info', text: text.cancelled })
      else setMessage({ tone: 'error', text: result.error ?? text.configureFailed })
    } catch (error) {
      setMessage({ tone: 'error', text: `${text.configureFailed} ${describe(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const clearFolder = async (): Promise<void> => {
    if (!bridge || busy) return
    setBusy('folder')
    setMessage(null)
    try {
      const result = await bridge.configure(null)
      if (result.ok) await refresh()
      else setMessage({ tone: 'error', text: result.error ?? text.configureFailed })
    } catch (error) {
      setMessage({ tone: 'error', text: `${text.configureFailed} ${describe(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const syncNow = async (): Promise<void> => {
    if (!bridge || busy || !configured) return
    setBusy('sync')
    setMessage(null)
    try {
      const result = await bridge.now()
      if (result.ok) {
        setMessage({
          tone: 'info',
          text: fill(text.syncDone, {
            pushed: result.pushed,
            pulled: result.pulled,
            conflicts: result.conflicts,
            skipped: result.skipped
          })
        })
      } else {
        setMessage({ tone: 'error', text: result.error ?? text.syncFailed })
      }
      await refresh()
    } catch (error) {
      setMessage({ tone: 'error', text: `${text.syncFailed} ${describe(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const resolve = async (id: string, resolution: SyncResolution): Promise<void> => {
    if (!bridge || busy) return
    setBusy(id)
    setMessage(null)
    try {
      const result = await bridge.resolve(id, resolution)
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? text.resolveFailed })
      await refresh()
    } catch (error) {
      setMessage({ tone: 'error', text: `${text.resolveFailed} ${describe(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const exportSession = async (): Promise<void> => {
    if (!bridge || busy) return
    setBusy('export')
    setMessage(null)
    try {
      const result = await bridge.exportSession()
      if (result.ok && result.path) setMessage({ tone: 'info', text: fill(text.exportDone, { path: result.path }) })
      else if (result.cancelled) setMessage({ tone: 'info', text: text.cancelled })
      else setMessage({ tone: 'error', text: result.error ?? text.syncFailed })
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) })
    } finally {
      setBusy(null)
    }
  }

  const importSession = async (): Promise<void> => {
    if (!bridge || busy) return
    setBusy('import')
    setMessage(null)
    try {
      const result = await bridge.importSession()
      if (result.ok && result.sessionId) setMessage({ tone: 'info', text: fill(text.importDone, { id: result.sessionId }) })
      else if (result.cancelled) setMessage({ tone: 'info', text: text.cancelled })
      else setMessage({ tone: 'error', text: result.error ?? text.syncFailed })
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) })
    } finally {
      setBusy(null)
    }
  }

  if (!bridge) {
    return (
      <section className="sync-page" data-testid="v3-sync-settings" data-wired="0">
        <p className="sync-note" role="note">
          {text.bridgeMissing}
        </p>
      </section>
    )
  }

  const last = status?.lastSync
  const errors = last?.errors ?? []

  return (
    <section className="sync-page" data-testid="v3-sync-settings" data-wired="1">
      <p className="sync-note" role="note">
        {text.note}
      </p>

      <div className="sync-card" data-testid="v3-sync-folder">
        <h3 className="sync-card__title">{text.folder}</h3>
        <p className="sync-path" data-testid="v3-sync-folder-path" title={status?.syncRoot ?? ''}>
          {status?.syncRoot ?? text.folderUnset}
        </p>
        <p className="sync-hint">{text.folderRecommend}</p>
        <div className="sync-actions">
          <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void chooseFolder()}>
            {text.folderPick}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy !== null || !configured}
            onPress={() => void clearFolder()}
          >
            {text.folderClear}
          </Button>
          <Button size="sm" variant="primary" isDisabled={busy !== null || !configured} onPress={() => void syncNow()}>
            {busy === 'sync' ? text.syncing : text.syncNow}
          </Button>
        </div>
      </div>

      <div className="sync-card" data-testid="v3-sync-last">
        <h3 className="sync-card__title">{text.lastTitle}</h3>
        {!last ? (
          <p className="sync-hint">{text.lastNever}</p>
        ) : (
          <div className="sync-last">
            <p className="sync-last__line">
              <span>{text.lastAt}</span>
              <span>{formatTime(last.at, lang)}</span>
              <span>{text.lastOk}</span>
              <span data-ok={last.ok ? '1' : '0'}>{last.ok ? 'OK' : text.lastFailed}</span>
            </p>
            <p className="sync-last__counts">
              {fill(text.resultPushed, { n: last.pushed })} · {fill(text.resultPulled, { n: last.pulled })} ·{' '}
              {fill(text.resultConflicts, { n: last.conflicts })} · {fill(text.resultSkipped, { n: last.skipped })}
            </p>
            {errors.length ? (
              <ul className="sync-errors">
                {errors.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      <Separator />

      <div className="sync-card" data-testid="v3-sync-conflicts">
        <h3 className="sync-card__title">{text.conflictsTitle}</h3>
        <p className="sync-hint">{text.conflictsHint}</p>
        {conflicts.length === 0 ? (
          <p className="sync-hint" data-testid="v3-sync-conflicts-none">
            {text.conflictsNone}
          </p>
        ) : (
          <ul className="sync-conflicts">
            {conflicts.map((conflict) => (
              <li className="sync-conflict" key={conflict.id} data-testid={`v3-sync-conflict-${conflict.id}`}>
                <div className="sync-conflict__head">
                  <Badge tone="ask">{text.kinds[conflict.kind]}</Badge>
                  <span className="sync-conflict__key" title={conflict.key}>
                    {conflict.key}
                  </span>
                </div>
                <div className="sync-conflict__sides">
                  <div className="sync-conflict__side">
                    <span className="sync-conflict__side-title">
                      {text.localSide}
                      {conflict.localDeviceName ? ` · ${conflict.localDeviceName}` : ''}
                    </span>
                    <span className="sync-conflict__meta">{formatTime(conflict.localModifiedAt, lang)}</span>
                    <p className="sync-conflict__preview">{conflict.localPreview ?? text.noLocal}</p>
                  </div>
                  <div className="sync-conflict__side">
                    <span className="sync-conflict__side-title">
                      {fill(text.remoteSide, { device: conflict.remoteDeviceName })}
                    </span>
                    <span className="sync-conflict__meta">{formatTime(conflict.remoteModifiedAt, lang)}</span>
                    <p className="sync-conflict__preview">{conflict.remotePreview ?? text.noLocal}</p>
                  </div>
                </div>
                <div className="sync-conflict__actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy !== null}
                    onPress={() => void resolve(conflict.id, 'local')}
                  >
                    {text.keepLocal}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy !== null}
                    onPress={() => void resolve(conflict.id, 'remote')}
                  >
                    {text.keepRemote}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy !== null}
                    onPress={() => void resolve(conflict.id, 'both')}
                  >
                    {text.keepBoth}
                  </Button>
                  {busy === conflict.id ? <span className="sync-hint">{text.resolving}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Separator />

      <div className="sync-card" data-testid="v3-sync-session">
        <h3 className="sync-card__title">{text.sessionTitle}</h3>
        <p className="sync-hint">{text.sessionNote}</p>
        <div className="sync-actions">
          <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void exportSession()}>
            {busy === 'export' ? text.exporting : text.exportSession}
          </Button>
          <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void importSession()}>
            {busy === 'import' ? text.importing : text.importSession}
          </Button>
        </div>
      </div>

      {message ? (
        <p className="sync-msg" data-tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
