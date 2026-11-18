import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { AttachmentUsage, IncompleteRestoreView, StorageInfoView, SubagentStorageUsage } from '../../../../../shared/ipc'
import { BACKUP_PART_LABELS, type BackupAction, type BackupSummary } from '../../../../../shared/data-backup'
import { useStore } from '../../../state/store'
import { Button, ConfirmDialog, Notice, Switch } from '../../../ui'
import { generalText, type GeneralText } from './general-text'
import { devicesDataText } from './devices-data-text'
import { bytesText } from './general-model'
import { SettingsAdvanced, SettingsGroup, SettingsRow } from '../root/controls'
import { settingsText } from '../settings-text'
import { PiShareDestinationGroup } from './PiNativeSettings'
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
      {info.pendingTarget ? (
        <span className="settings-row__desc" data-testid="v3-data-pending">
          {text.dataMovePending.replace('{path}', info.pendingTarget)}
        </span>
      ) : null}
      {last && !last.ok && last.error ? (
        <span className="settings-row__desc settings-row__desc--error">
          {text.dataLastFailed.replace('{error}', last.error)}
        </span>
      ) : null}
    </div>
  )
}

type DataScope = 'storage' | 'backup' | 'verify' | 'restore' | 'session'

interface DataMessage {
  scope: DataScope
  tone: 'info' | 'fail'
  text: string
}

function DataMessageLine({ message, scope }: { message: DataMessage | null; scope: DataScope }): ReactElement | null {
  if (!message || message.scope !== scope) return null
  return (
    <Notice tone={message.tone} compact className="dd-message">
      {message.text}
    </Notice>
  )
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ipcReason(cause: unknown): string {
  return describe(cause).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function SubagentStorageLine(): ReactElement | null {
  const { t } = useI18n()
  const [usage, setUsage] = useState<SubagentStorageUsage | null>(null)

  useEffect(() => {
    let alive = true
    const load = window.yan.subagents?.storage
    if (load) void load().then((value) => alive && setUsage(value), () => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (!usage) return null
  return (
    <span className="settings-row__line" data-testid="v3-data-subagent-storage">
      {t('set.dataSubagentStorage', {
        used: bytesText(usage.recordBytes + usage.sessionBytes + usage.patchBytes),
        cap: bytesText(usage.maxBytes),
        count: usage.records,
        outputs: bytesText(usage.outputsBytes),
        outputsCap: bytesText(usage.outputsMaxBytes)
      })}
    </span>
  )
}

function AttachmentsRow(): ReactElement {
  const { t } = useI18n()
  const [usage, setUsage] = useState<AttachmentUsage | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'fail'; text: string } | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    void window.yan.attachments.usage().then(
      (value) => alive && setUsage(value),
      (cause) => alive && setNote({ tone: 'fail', text: ipcReason(cause) })
    )
    return () => {
      alive = false
    }
  }, [])

  const prune = async (): Promise<void> => {
    setNote({ tone: 'info', text: t('pkg.attachScanning') })
    try {
      const result = await window.yan.attachments.prune()
      setUsage(await window.yan.attachments.usage())
      setNote({ tone: 'info', text: result.removed ? t('pkg.attachDone', { n: result.removed, size: bytesText(result.bytes) }) : t('pkg.attachNone') })
    } catch (cause) {
      setNote({ tone: 'fail', text: `${ipcReason(cause)} ${t('pkg.attachRetry')}` })
    }
  }

  const size = usage ? t('pkg.attachSize', { files: usage.files, size: bytesText(usage.bytes) }) : ''
  return (
    <>
      <SettingsRow
        settingId="data-attachments"
        label={t('pkg.attach')}
        description={
          <>
            {t('pkg.attachDesc')}
            <span className="settings-row__line">{t('pkg.attachAuto')}</span>
            {size ? <span className="settings-row__line" data-testid="v3-data-attachments-size">{size}</span> : null}
          </>
        }
      >
        <Button variant="secondary" isDisabled={!usage?.files} onPress={() => setConfirming(true)} data-testid="v3-data-attachments-prune">
          {t('pkg.attachClean')}
        </Button>
      </SettingsRow>
      {note ? <Notice tone={note.tone} compact className="dd-message" data-testid="v3-data-attachments-note">{note.text}</Notice> : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t('pkg.attachClean')}
        description={`${t('pkg.attachDesc')}\n${t('pkg.attachCleanNote')}`}
        confirmLabel={t('pkg.attachClean')}
        tone="danger"
        onConfirm={prune}
        data-testid="v3-data-attachments-confirm"
      >
        {size}
      </ConfirmDialog>
    </>
  )
}

function IncompleteRestoresRows({ reload }: { reload: number }): ReactElement | null {
  const { lang } = useI18n()
  const local = devicesDataText(lang)
  const [items, setItems] = useState<IncompleteRestoreView[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.yan.incompleteRestores.list().then(
      (value) => alive && setItems(value),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [reload])

  const trash = async (path: string): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await window.yan.incompleteRestores.trash(path)
      if (!result.ok) setNote(local.restoreIncompleteFailed.replace('{error}', result.error ?? ''))
      setItems(await window.yan.incompleteRestores.list())
    } catch (cause) {
      setNote(local.restoreIncompleteFailed.replace('{error}', ipcReason(cause)))
    } finally {
      setBusy(false)
    }
  }

  if (!items.length) return null
  return (
    <>
      {items.map((item) => (
        <SettingsRow
          key={item.path}
          settingId="data-restore-incomplete"
          label={local.restoreIncompleteTitle}
          description={
            <span data-testid="v3-data-restore-incomplete">
              {local.restoreIncompleteDesc.replace('{path}', item.path).replace('{size}', bytesText(item.bytes))}
              {item.error ? <span className="settings-row__line settings-row__desc--error">{item.error}</span> : null}
            </span>
          }
        >
          <Button variant="secondary" onPress={() => void window.yan.revealPath(item.path)}>
            {generalText(lang).dataOpen}
          </Button>
          <Button variant="secondary" isDisabled={busy} data-testid="v3-data-restore-incomplete-trash" onPress={() => void trash(item.path)}>
            {local.restoreIncompleteTrash}
          </Button>
        </SettingsRow>
      ))}
      {note ? <Notice tone="fail" compact className="dd-message">{note}</Notice> : null}
    </>
  )
}

function OldCopyRow({ info, onChanged }: { info: StorageInfoView | null; onChanged: () => Promise<void> }): ReactElement | null {
  const { lang } = useI18n()
  const local = devicesDataText(lang)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  if (!info?.oldCopy) return null
  const oldCopy = info.oldCopy
  const trash = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await window.yan.storage.trashOldCopy(oldCopy.path)
      if (!result.ok) setNote(local.oldCopyFailed.replace('{error}', result.error ?? ''))
      await onChanged()
    } catch (cause) {
      setNote(local.oldCopyFailed.replace('{error}', ipcReason(cause)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SettingsRow
        settingId="data-old-copy"
        label={local.oldCopyTitle}
        description={<span data-testid="v3-data-old-copy">{local.oldCopyDesc.replace('{path}', oldCopy.path).replace('{size}', bytesText(oldCopy.bytes))}</span>}
      >
        <Button variant="secondary" data-testid="v3-data-old-copy-open" onPress={() => void window.yan.revealPath(oldCopy.path)}>
          {generalText(lang).dataOpen}
        </Button>
        <Button variant="secondary" isDisabled={busy} data-testid="v3-data-old-copy-trash" onPress={() => void trash()}>
          {local.oldCopyTrash}
        </Button>
      </SettingsRow>
      {note ? <Notice tone="fail" compact className="dd-message">{note}</Notice> : null}
    </>
  )
}

export function DataSettings(): ReactElement {
  const { lang, t } = useI18n()
  const pruneHistory = useStore((s) => s.settings?.subagentHistoryPrune !== false)
  const patchSettings = useStore((s) => s.patchSettings)
  const text = generalText(lang)
  const labels = settingsText(lang)
  const local = devicesDataText(lang)
  const session = useStore((s) => s.session)
  const [info, setInfo] = useState<StorageInfoView | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState<DataScope | 'import' | null>(null)
  const [summary, setSummary] = useState<{ action: 'create' | 'verify' | 'restore'; value: BackupSummary } | null>(null)
  const [message, setMessage] = useState<DataMessage | null>(null)
  const [incompleteTick, setIncompleteTick] = useState(0)

  useEffect(() => {
    void window.yan.storage
      .info()
      .then((value) => setInfo(value))
      .catch((cause) => setMessage({ scope: 'storage', tone: 'fail', text: describe(cause) }))
  }, [])

  const loadInfo = async (): Promise<void> => {
    try {
      setInfo(await window.yan.storage.info())
    } catch (cause) {
      setMessage({ scope: 'storage', tone: 'fail', text: describe(cause) })
    }
  }

  const pick = async (): Promise<void> => {
    setMessage(null)
    try {
      const dir = await window.yan.storage.pick()
      if (dir) setTarget(dir)
    } catch (cause) {
      setMessage({ scope: 'storage', tone: 'fail', text: describe(cause) })
    }
  }

  const move = async (): Promise<void> => {
    if (!target) return
    setBusy('storage')
    setMessage(null)
    try {
      const result = await window.yan.storage.schedule(target, true)
      if (result.ok) {
        setMessage({ scope: 'storage', tone: 'info', text: text.dataMoveScheduled })
        setTarget(null)
        await loadInfo()
      } else {
        setMessage({ scope: 'storage', tone: 'fail', text: result.error ?? text.dataMoveConfirm })
      }
    } catch (cause) {
      setMessage({ scope: 'storage', tone: 'fail', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const backup = async (action: BackupAction): Promise<void> => {
    const summaryAction = action === 'open-restored' ? 'restore' : action
    const scope: DataScope = summaryAction === 'create' ? 'backup' : summaryAction
    setBusy(scope)
    setMessage(null)
    if (action !== 'open-restored') setSummary(null)
    try {
      const result = await window.yan.backup(action)
      if (result.ok) setSummary({ action: summaryAction, value: result.summary })
      else if (!result.cancelled) setMessage({ scope, tone: 'fail', text: result.error ?? text.dataBackup })
    } catch (cause) {
      setMessage({ scope, tone: 'fail', text: describe(cause) })
    } finally {
      setBusy(null)
      if (action === 'restore') setIncompleteTick((value) => value + 1)
    }
  }

  const exportSession = async (): Promise<void> => {
    setBusy('session')
    setMessage(null)
    try {
      const path = session?.conversationFile ?? session?.sessionFile
      const result = await window.yan.sessionTransfer.exportSession(path)
      if (result.ok && result.path) setMessage({ scope: 'session', tone: 'info', text: local.exportDone.replace('{path}', result.path) })
      else if (!result.cancelled) setMessage({ scope: 'session', tone: 'fail', text: result.error || local.transferFailed })
    } catch (cause) {
      setMessage({ scope: 'session', tone: 'fail', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const importSession = async (): Promise<void> => {
    setBusy('import')
    setMessage(null)
    try {
      const result = await window.yan.sessionTransfer.importSession()
      if (result.ok && result.sessionId) {
        await useStore.getState().refreshSessions()
        setMessage({ scope: 'session', tone: 'info', text: local.importDone.replace('{id}', result.sessionId) })
      } else if (!result.cancelled) setMessage({ scope: 'session', tone: 'fail', text: result.error || local.transferFailed })
    } catch (cause) {
      setMessage({ scope: 'session', tone: 'fail', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }

  const summaryLine = (action: 'create' | 'verify' | 'restore'): ReactElement | null =>
    summary?.action === action ? (
      <>
        <br />
        <span data-testid="v3-data-backup-summary" role="status">
          {(action === 'restore' ? local.dataBackupRestored : text.dataBackupChecked).replace('{files}', String(summary.value.files)).replace('{size}', bytesText(summary.value.bytes))}
          {' · '}
          <span className="settings-path" title={summary.value.path}>
            {summary.value.path}
          </span>
        </span>
      </>
    ) : null

  const summaryNotes = (action: 'create' | 'verify' | 'restore'): ReactElement | null => {
    if (summary?.action !== action) return null
    const { skipped, changed, changedTotal } = summary.value
    if (!skipped?.length && !changed?.length) return null
    const changeLabel = (kind: 'modified' | 'removed' | 'added'): string => (kind === 'removed' ? ` (${local.backupRemoved})` : kind === 'added' ? ` (${local.backupAdded})` : '')
    return (
      <>
        {skipped?.length ? (
          <Notice tone="stall" compact className="dd-message" data-testid="v3-data-backup-skipped">
            {local.backupSkipped.replace('{parts}', skipped.map((item) => `${BACKUP_PART_LABELS[item.part][lang === 'en-US' ? 'en' : 'zh']} (${item.files}, ${bytesText(item.bytes)})`).join(' / '))}
          </Notice>
        ) : null}
        {changed?.length ? (
          <Notice tone="stall" compact className="dd-message" data-testid="v3-data-backup-changed">
            {local.backupChanged
              .replace('{count}', String(changedTotal ?? changed.length))
              .replace('{files}', changed.slice(0, 5).map((item) => `${item.path}${changeLabel(item.kind)}`).join(' / ') + ((changedTotal ?? changed.length) > 5 ? ' …' : ''))}
          </Notice>
        ) : null}
      </>
    )
  }

  const openSummary = (action: 'create' | 'verify' | 'restore'): ReactElement | null =>
    summary?.action === action ? (
      <Button variant="secondary" onPress={() => void window.yan.revealPath(summary.value.path)}>
        {text.dataOpen}
      </Button>
    ) : null

  const cancelMove = async (): Promise<void> => {
    setBusy('storage')
    setMessage(null)
    try {
      await window.yan.storage.cancel()
      await loadInfo()
    } catch (cause) {
      setMessage({ scope: 'storage', tone: 'fail', text: describe(cause) })
    } finally {
      setBusy(null)
    }
  }
  const canMove = Boolean(info?.movable && !info.relocated && !info.pendingTarget)

  return (
    <section className="settings-section" data-testid="v3-data-settings">
      <SettingsGroup title={labels.groupDataBackup}>
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
          <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-backup-create" onPress={() => void backup('create')}>
            {busy === 'backup' ? text.dataBackupWorking : text.dataBackupCreateAction}
          </Button>
        </SettingsRow>
        <DataMessageLine message={message} scope="backup" />
        {summaryNotes('create')}
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
          <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-backup-verify" onPress={() => void backup('verify')}>
            {busy === 'verify' ? text.dataBackupWorking : text.dataBackupVerifyAction}
          </Button>
        </SettingsRow>
        <DataMessageLine message={message} scope="verify" />
        {summaryNotes('verify')}
        <SettingsRow
          settingId="data-backup-restore"
          label={local.dataBackupRestore}
          description={<>{local.dataBackupRestoreDesc}{summaryLine('restore')}</>}
        >
          {openSummary('restore')}
          {summary?.action === 'restore' ? (
            <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-backup-open-restored" onPress={() => void backup('open-restored')}>
              {local.dataBackupOpenRestored}
            </Button>
          ) : null}
          <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-backup-restore" onPress={() => void backup('restore')}>
            {busy === 'restore' ? text.dataBackupWorking : text.dataBackupRestoreAction}
          </Button>
        </SettingsRow>
        <DataMessageLine message={message} scope="restore" />
        <IncompleteRestoresRows reload={incompleteTick} />
      </SettingsGroup>

      <SettingsAdvanced label={labels.advanced} testId="v3-data-advanced">
        <SettingsGroup title={labels.groupDataStorage}>
          <SettingsRow
            settingId="data-location"
            label={text.dataLocation}
            description={
              <>
                {text.dataLocationDesc}
                <StorageFacts info={info} text={text} />
              </>
            }
          >
            {info ? (
              <Button variant="secondary" onPress={() => void window.yan.revealPath(info.realDir)}>
                {text.dataOpen}
              </Button>
            ) : null}
          </SettingsRow>
          <SettingsRow
            settingId="data-move"
            label={text.dataMove}
            description={
              <>
                {local.dataMoveDesc}
                {target ? <span className="settings-row__line">{text.dataTarget.replace('{path}', target)}</span> : null}
                {info && !info.movable ? <span className="settings-row__line">{text.dataNotMovable}</span> : null}
              </>
            }
          >
            {info?.pendingTarget ? (
              <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-move-cancel" onPress={() => void cancelMove()}>
                {t('set.dataCancelScheduledMove')}
              </Button>
            ) : canMove && target ? (
              <>
                <Button variant="secondary" isDisabled={busy !== null} onPress={() => setTarget(null)}>
                  {text.cancel}
                </Button>
                <Button variant="primary" isDisabled={busy !== null} data-testid="v3-data-move-confirm" onPress={() => void move()}>
                  {busy === 'storage' ? text.dataMoving : text.dataMoveConfirm}
                </Button>
              </>
            ) : canMove ? (
              <Button variant="secondary" data-testid="v3-data-move" onPress={() => void pick()}>
                {text.dataMove}
              </Button>
            ) : null}
          </SettingsRow>
          <DataMessageLine message={message} scope="storage" />
          <OldCopyRow info={info} onChanged={loadInfo} />
          <SettingsRow
            settingId="data-subagent-prune"
            label={t('set.dataSubagentPrune')}
            description={
              <>
                {t('set.dataSubagentPruneDesc')}
                <SubagentStorageLine />
              </>
            }
          >
            <Switch
              aria-label={t('set.dataSubagentPrune')}
              isSelected={pruneHistory}
              onChange={(on) => void patchSettings({ subagentHistoryPrune: on })}
              data-testid="v3-data-subagent-prune"
            />
          </SettingsRow>
          <AttachmentsRow />
        </SettingsGroup>

        <SettingsGroup title={local.sessionTransfer}>
          <SettingsRow settingId="data-session-export" label={local.exportSession} description={local.dataExportDesc}>
            <Button
              variant="secondary"
              isDisabled={busy !== null || !session?.sessionId}
              data-testid="v3-data-export"
              onPress={() => void exportSession()}
            >
              {busy === 'session' ? local.exporting : text.dataSessionExportAction}
            </Button>
          </SettingsRow>
          <SettingsRow settingId="data-session-import" label={local.importSession} description={local.dataImportDesc}>
            <Button variant="secondary" isDisabled={busy !== null} data-testid="v3-data-import" onPress={() => void importSession()}>
              {busy === 'import' ? local.importing : text.dataSessionImportAction}
            </Button>
          </SettingsRow>
          <DataMessageLine message={message} scope="session" />
        </SettingsGroup>

        <PiShareDestinationGroup title={labels.groupDataShare} />
      </SettingsAdvanced>
    </section>
  )
}
