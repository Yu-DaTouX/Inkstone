import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import type { StorageInfoView } from '../../../../shared/ipc'
import { Button, SettingRow } from '../ui'

/**
 * 数据位置：会话、凭证、语音模型、浏览器配置默认都在 C 盘用户目录。
 * 这里可以把整个数据目录搬到别的盘（下次启动时执行，见 main/storage-move.ts）；
 * 原位置留一个目录联接，旧会话记录与终端里的 pi 照常可用。
 */
export function StorageSection() {
  const t = useT()
  const [info, setInfo] = useState<StorageInfoView | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.yan.storage.info().then(setInfo).catch(() => undefined)
  }, [])

  const gb = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)
  const last = info?.lastResult

  const pick = async (): Promise<void> => {
    setError('')
    const dir = await window.yan.storage.pick()
    if (dir) setTarget(dir)
  }
  const confirm = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError('')
    const r = await window.yan.storage.schedule(target, true)
    setBusy(false)
    if (!r.ok) setError(r.error ?? t('storage.failed'))
  }

  return (
    <SettingRow
      name={t('storage.title')}
      desc={
        <>
          <span className="set-path" title={info?.realDir}>{info ? `${info.realDir} · ${gb(info.bytes)}` : '…'}</span>
          {info?.relocated ? <div>{t('storage.relocatedNote', { path: info.agentDir })}</div> : null}
          {last && !last.ok && last.error ? <div className="set-warn">{t('storage.lastFailed', { error: last.error })}</div> : null}
          {info?.strandedBackup ? <div className="set-warn" data-testid="storage-stranded">{t('storage.stranded', { path: info.strandedBackup })}</div> : null}
          {last?.ok && last.leftover ? <div className="set-warn">{t('storage.leftover', { path: last.leftover })}</div> : null}
          {target ? (
            <div data-testid="storage-target">
              {t('storage.confirm', { path: target })}
            </div>
          ) : null}
          {error ? <div className="set-warn">{error}</div> : null}
          {info && !info.movable ? <div>{t('storage.notMovable')}</div> : null}
        </>
      }
    >
      {info?.movable && !info.relocated ? (
        target ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setTarget(null)} disabled={busy}>{t('ui.cancel')}</Button>
            <Button size="sm" variant="primary" onClick={() => void confirm()} disabled={busy} data-testid="storage-confirm">
              {busy ? t('storage.checking') : t('storage.moveAndRestart')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void pick()} data-testid="storage-pick">{t('storage.move')}</Button>
        )
      ) : info?.relocated ? (
        <Button size="sm" variant="ghost" onClick={() => void window.yan.revealPath(info.realDir)}>{t('storage.open')}</Button>
      ) : null}
    </SettingRow>
  )
}
