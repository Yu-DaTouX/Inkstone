import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { StorageInfoView } from '../../../../../shared/ipc'
import type { BackupSummary } from '../../../../../shared/data-backup'
import { useStore } from '../../../state/store'
import { Button } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { bytesText } from './general-model'
import { SettingsGroup, SettingsRow } from '../root/controls'

export interface StorageFactsProps {
  info: StorageInfoView | null
  text: GeneralText
}

export function StorageFacts({ info, text }: StorageFactsProps): ReactElement {
  if (!info) {
    return (
      <p className="settings-row__desc" data-testid="v3-data-location-loading">
        {text.loading}
      </p>
    )
  }
  const last = info.lastResult
  return (
    <div className="settings-data" data-testid="v3-data-location">
      <span className="settings-path" title={info.realDir}>
        {info.realDir} · {text.dataSize} {bytesText(info.bytes)}
      </span>
      {info.relocated ? (
        <span className="settings-row__desc">{text.devicesSyncConfigured.replace('{path}', info.agentDir)}</span>
      ) : null}
      {info.strandedBackup ? (
        <span className="settings-row__desc settings-row__desc--error" data-testid="v3-data-stranded">
          {text.dataStranded.replace('{path}', info.strandedBackup)}
        </span>
      ) : null}
      {last && !last.ok && last.error ? (
        <span className="settings-row__desc settings-row__desc--error">
          {text.dataLastFailed.replace('{error}', last.error)}
        </span>
      ) : null}
      {!info.movable ? <span className="settings-row__desc">{text.dataNotMovable}</span> : null}
    </div>
  )
}

export function DataSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const session = useStore((s) => s.session)
  const [info, setInfo] = useState<StorageInfoView | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<BackupSummary | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void window.yan.storage
      .info()
      .then((value) => {
        if (alive) setInfo(value)
      })
      .catch((cause) => {
        if (alive) setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => {
      alive = false
    }
  }, [])

  const pick = async (): Promise<void> => {
    setMessage(null)
    try {
      const dir = await window.yan.storage.pick()
      if (dir) setTarget(dir)
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const move = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.yan.storage.schedule(target, true)
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? text.dataMoveConfirm })
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const backup = async (action: 'create' | 'verify'): Promise<void> => {
    setBusy(true)
    setMessage(null)
    setSummary(null)
    try {
      const result = await window.yan.backup(action)
      if (result.ok) setSummary(result.summary)
      else if (!result.cancelled) setMessage({ tone: 'error', text: result.error ?? text.dataBackup })
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const exportSession = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const path = session?.conversationFile ?? session?.sessionFile
      const result = await window.yan.sync.exportSession(path)
      if (result.ok && result.path) setMessage({ tone: 'info', text: text.dataExportDone.replace('{path}', result.path) })
      else if (!result.cancelled) setMessage({ tone: 'error', text: result.error ?? text.dataExport })
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" data-testid="v3-data-settings">
      <SettingsGroup label={text.dataLocation}>
        <SettingsRow block label={text.dataLocation} description={text.dataLocationDesc}>
          <StorageFacts info={info} text={text} />
          <div className="settings-actions">
            {info?.movable && !info.relocated ? (
              target ? (
                <>
                  <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setTarget(null)}>
                    {text.cancel}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    isDisabled={busy}
                    data-testid="v3-data-move-confirm"
                    onPress={() => void move()}
                  >
                    {busy ? text.dataMoving : text.dataMoveConfirm}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" data-testid="v3-data-move" onPress={() => void pick()}>
                  {text.dataMove}
                </Button>
              )
            ) : info?.relocated ? (
              <Button size="sm" variant="ghost" onPress={() => void window.yan.revealPath(info.realDir)}>
                {text.dataOpen}
              </Button>
            ) : null}
          </div>
          {target ? <span className="settings-row__desc">{text.dataTarget.replace('{path}', target)}</span> : null}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={text.dataBackup}>
        <SettingsRow block label={text.dataBackup} description={text.dataBackupDesc}>
          <div className="settings-actions">
            <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void backup('create')}>
              {busy ? text.dataBackupWorking : text.dataBackupCreate}
            </Button>
            <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void backup('verify')}>
              {text.dataBackupVerify}
            </Button>
            {summary ? (
              <Button size="sm" variant="ghost" onPress={() => void window.yan.revealPath(summary.path)}>
                {text.dataOpen}
              </Button>
            ) : null}
          </div>
          {summary ? (
            <span className="settings-row__desc" data-testid="v3-data-backup-summary" role="status">
              {text.dataBackupChecked
                .replace('{files}', String(summary.files))
                .replace('{size}', bytesText(summary.bytes))}
              {' · '}
              <span className="settings-path" title={summary.path}>
                {summary.path}
              </span>
            </span>
          ) : null}
        </SettingsRow>

        <SettingsRow block label={text.dataExport} description={text.dataExportDesc}>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || !session?.sessionId}
            data-testid="v3-data-export"
            onPress={() => void exportSession()}
          >
            {text.dataExportAction}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <p className="settings-note" role="note">
        {text.dataDangerNote}
      </p>

      {message ? (
        <p className="settings-row__desc" data-tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
