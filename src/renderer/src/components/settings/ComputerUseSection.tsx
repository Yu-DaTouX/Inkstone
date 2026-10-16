import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { ComputerUseStatusView } from '../../../../shared/ipc'
import { Button, Switch } from '../ui'

const REPO = 'https://github.com/cursortouch/windows-mcp'
const UV_DOCS = 'https://docs.astral.sh/uv/getting-started/installation/'

export function ComputerUseSection(): React.JSX.Element | null {
  const t = useT()
  const [status, setStatus] = useState<ComputerUseStatusView | null>(null)
  const [busy, setBusy] = useState<'uv' | 'toggle' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [manual, setManual] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.yan.computerUse.status()
      if (alive.current) setStatus(next)
    } catch {
      if (alive.current) setStatus(null)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (status && !status.supported) return null

  const installUv = async (): Promise<void> => {
    setBusy('uv')
    setResult(null)
    try {
      const r = await window.yan.computerUse.installUv()
      if (!alive.current) return
      setManual(!!r.needsManual)
      setResult({ ok: r.ok, text: r.ok ? t('cu.uvInstalled') : [r.error, r.log].filter(Boolean).join('\n') })
    } catch (e) {
      if (alive.current) setResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      if (alive.current) setBusy(null)
    }
    if (alive.current) await refresh()
  }
  const toggle = async (next: boolean): Promise<void> => {
    setBusy('toggle')
    setResult(null)
    try {
      const r = await window.yan.computerUse.set(next)
      if (!alive.current) return
      setResult(r.ok ? (next ? { ok: true, text: t('cu.enabled') } : null) : { ok: false, text: [r.error, r.log].filter(Boolean).join('\n') })
    } catch (e) {
      if (alive.current) setResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      if (alive.current) setBusy(null)
    }
    if (alive.current) await refresh()
  }

  return (
    <div className="ui-row set-row-col" data-testid="cap-computer-use">
      <div className="set-cu-head">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('cu.title')}</div>
          <div className="ui-row-desc">{t('cu.desc')}</div>
        </div>
        <div className="ui-row-ctl">
          <Switch
            checked={!!status?.enabled}
            disabled={!status?.uvx || busy !== null}
            label={t('cu.title')}
            testId="cap-computer-use-switch"
            onChange={(next) => void toggle(next)}
          />
        </div>
      </div>
      {busy === 'toggle' ? <div className="ui-row-desc">{status?.enabled ? t('cu.disabling') : t('cu.preparing')}</div> : null}
      {status && !status.uvx ? (
        <>
          <div className="ui-row-desc">{t('cu.needUv')}</div>
          <div className="set-install-actions">
            {status.canInstallUv ? (
              <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void installUv()}>
                {busy === 'uv' ? t('cu.uvInstalling') : t('cu.installUv')}
              </Button>
            ) : null}
            {!status.canInstallUv || manual ? (
              <Button size="sm" onClick={() => void window.yan.browser.openExternal(UV_DOCS)}>
                {t('cu.uvDocs')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {result ? <div className={`ui-row-desc set-install-log ${result.ok ? '' : 'err'}`}>{result.text}</div> : null}
      <div className="ui-row-desc">{t('cu.scope')}</div>
      <div className="set-install-actions">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>{t('set.extRecheck')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void window.yan.browser.openExternal('https://pypi.org/project/windows-mcp/#history')}>{t('set.releasePage')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void window.yan.browser.openExternal(REPO)}>
          {t('cu.repo')}
        </Button>
      </div>
    </div>
  )
}
