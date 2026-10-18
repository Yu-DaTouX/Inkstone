import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { StorageInfoView } from '../../../../../shared/ipc'
import type { BackupSummary } from '../../../../../shared/data-backup'
import { useStore } from '../../../state/store'
import { Button } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { devicesDataText } from './devices-data-text'
import { bytesText } from './general-model'
import { SettingsGroup, SettingsMore, SettingsRow } from '../root/controls'
import { PiShareDestinationGroup } from './PiNativeSettings'
import { SyncConflictsGroup, SyncGroup, fillTemplate, useSyncPanel } from '../sync/SyncSettings'
import { syncText } from '../sync/text'
import './devices-data.css'

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

type DataScope = 'storage' | 'backup' | 'verify' | 'session'

interface DataMessage {
  scope: DataScope
  tone: 'info' | 'error'
  text: string
}

function DataMessageLine({ message, scope }: { message: DataMessage | null; scope: DataScope }): ReactElement | null {
  if (!message || message.scope !== scope) return null
  return (
    <p
      className={message.tone === 'error' ? 'settings-row__desc settings-row__desc--error dd-message' : 'settings-row__desc dd-message'}
      role={message.tone === 'error' ? 'alert' : 'status'}
    >
      {message.text}
    </p>
  )
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function DataSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const local = devicesDataText(lang)
  const sync = syncText(lang)
  const panel = useSyncPanel()
  const bridge = panel.bridge
  const session = useStore((s) => s.session)
  const [info, setInfo] = useState<StorageInfoView | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState<DataScope | 'import' | null>(null)
  const [summary, setSummary] = useState<{ action: 'create' | 'verify'; value: BackupSummary } | null>(null)
  const [message, setMessage] = useState<DataMessage | null>(null)

  useEffect(() => {
    let alive = true
    void window.yan.storage
      .info()
      .then((value) => {
        if (alive) setInfo(value)
      })
      .catch((cause) => {
        if (alive) setMessage({ scope: 'storage', tone: 'error', text: describe(cause) })
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
      setMessage({ scope: 'storage', tone: 'error', text: describe(cause) })
    }
  }

  const move = async (): Promise<void> => {
    if (!target) return
    setBusy('storage')
    setMessage(null)
    try {
      const result = await window.yan.storage.schedule(target, true)
      if (!result.ok) setMessage({ scope: 'storage', tone: 'error', text: result.error ?? text.dataMoveConfirm })
    } catch (cause) {
      setMessage({ scope: 'storage', tone: 'error', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const backup = async (action: 'create' | 'verify'): Promise<void> => {
    const scope: DataScope = action === 'create' ? 'backup' : 'verify'
    setBusy(scope)
    setMessage(null)
    setSummary(null)
    try {
      const result = await window.yan.backup(action)
      if (result.ok) setSummary({ action, value: result.summary })
      else if (!result.cancelled) setMessage({ scope, tone: 'error', text: result.error ?? text.dataBackup })
    } catch (cause) {
      setMessage({ scope, tone: 'error', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const exportSession = async (): Promise<void> => {
    setBusy('session')
    setMessage(null)
    try {
      const path = session?.conversationFile ?? session?.sessionFile
      const result = await window.yan.sync.exportSession(path)
      if (result.ok && result.path) setMessage({ scope: 'session', tone: 'info', text: fillTemplate(sync.exportDone, { path: result.path }) })
      else if (!result.cancelled) setMessage({ scope: 'session', tone: 'error', text: result.error ?? sync.syncFailed })
    } catch (cause) {
      setMessage({ scope: 'session', tone: 'error', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const importSession = async (): Promise<void> => {
    if (!bridge) return
    setBusy('import')
    setMessage(null)
    try {
      const result = await bridge.importSession()
      if (result.ok && result.sessionId) setMessage({ scope: 'session', tone: 'info', text: fillTemplate(sync.importDone, { id: result.sessionId }) })
      else if (!result.cancelled) setMessage({ scope: 'session', tone: 'error', text: result.error ?? sync.syncFailed })
    } catch (cause) {
      setMessage({ scope: 'session', tone: 'error', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const summaryLine = (action: 'create' | 'verify'): ReactElement | null =>
    summary?.action === action ? (
      <>
        <br />
        <span data-testid="v3-data-backup-summary" role="status">
          {text.dataBackupChecked.replace('{files}', String(summary.value.files)).replace('{size}', bytesText(summary.value.bytes))}
          {' · '}
          <span className="settings-path" title={summary.value.path}>
            {summary.value.path}
          </span>
        </span>
      </>
    ) : null

  const openSummary = (action: 'create' | 'verify'): ReactElement | null =>
    summary?.action === action ? (
      <Button size="sm" variant="secondary" onPress={() => void window.yan.revealPath(summary.value.path)}>
        {text.dataOpen}
      </Button>
    ) : null

  const canMove = Boolean(info?.movable && !info.relocated)

  return (
    <section className="settings-section" data-testid="v3-data-settings">
      <SettingsGroup label={text.dataBackupCreate}>
        <SettingsRow
          settingId="data-backup-create"
          label={text.dataBackupCreate}
          description={
            <>
              {text.dataBackupDesc}
              {summaryLine('create')}
            </>
          }
        >
          {openSummary('create')}
          <Button size="sm" variant="primary" isDisabled={busy !== null} data-testid="v3-data-backup-create" onPress={() => void backup('create')}>
            {busy === 'backup' ? text.dataBackupWorking : text.dataBackupCreate}
          </Button>
        </SettingsRow>
        <DataMessageLine message={message} scope="backup" />
      </SettingsGroup>

      <SettingsGroup label={text.dataLocation}>
        <SettingsRow block settingId="data-location" label={text.dataLocation} description={text.dataLocationDesc}>
          <StorageFacts info={info} text={text} />
          {info ? (
            <Button size="sm" variant="secondary" onPress={() => void window.yan.revealPath(info.realDir)}>
              {text.dataOpen}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>

      <SyncGroup panel={panel} />

      <SettingsMore>
        <SettingsGroup label={text.dataMove}>
          <SettingsRow
            settingId="data-move"
            label={text.dataMove}
            description={
              <>
                {local.dataMoveDesc}
                {target ? (
                  <>
                    <br />
                    {text.dataTarget.replace('{path}', target)}
                  </>
                ) : null}
              </>
            }
          >
            {canMove && target ? (
              <>
                <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => setTarget(null)}>
                  {text.cancel}
                </Button>
                <Button size="sm" variant="primary" isDisabled={busy !== null} data-testid="v3-data-move-confirm" onPress={() => void move()}>
                  {busy === 'storage' ? text.dataMoving : text.dataMoveConfirm}
                </Button>
              </>
            ) : canMove ? (
              <Button size="sm" variant="secondary" data-testid="v3-data-move" onPress={() => void pick()}>
                {text.dataMove}
              </Button>
            ) : null}
          </SettingsRow>
          <DataMessageLine message={message} scope="storage" />
        </SettingsGroup>

        <SettingsGroup label={text.dataBackupVerify}>
          <SettingsRow
            settingId="data-backup-verify"
            label={text.dataBackupVerify}
            description={
              <>
                {local.dataBackupVerifyDesc}
                {summaryLine('verify')}
              </>
            }
          >
            {openSummary('verify')}
            <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void backup('verify')}>
              {busy === 'verify' ? text.dataBackupWorking : text.dataBackupVerify}
            </Button>
          </SettingsRow>
          <DataMessageLine message={message} scope="verify" />
        </SettingsGroup>

        <SyncConflictsGroup panel={panel} />

        <SettingsGroup label={local.sessionTransfer}>
          <SettingsRow settingId="data-session-export" label={sync.exportSession} description={local.dataExportDesc}>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy !== null || !session?.sessionId}
              data-testid="v3-data-export"
              onPress={() => void exportSession()}
            >
              {busy === 'session' ? sync.exporting : sync.exportSession}
            </Button>
          </SettingsRow>
          {bridge ? (
            <SettingsRow settingId="data-session-import" label={sync.importSession} description={local.dataImportDesc}>
              <Button size="sm" variant="secondary" isDisabled={busy !== null} data-testid="v3-data-import" onPress={() => void importSession()}>
                {busy === 'import' ? sync.importing : sync.importSession}
              </Button>
            </SettingsRow>
          ) : null}
          <DataMessageLine message={message} scope="session" />
        </SettingsGroup>

        <div>
          <PiShareDestinationGroup />
        </div>
      </SettingsMore>
    </section>
  )
}
