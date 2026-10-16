import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { ComputerUseStatusView } from '../../../../../shared/ipc'
import { Button, Switch } from '../../../ui'
import { Actions, Group, Meta, Warn } from './parts'

const REPO = 'https://github.com/cursortouch/windows-mcp'
const UV_DOCS = 'https://docs.astral.sh/uv/getting-started/installation/'
const RELEASES = 'https://pypi.org/project/windows-mcp/#history'

export function ComputerUseSection(): ReactElement | null {
  const t = useT()
  const [status, setStatus] = useState<ComputerUseStatusView | null>(null)
  const [busy, setBusy] = useState<'uv' | 'toggle' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [manual, setManual] = useState(false)
  const [statusError, setStatusError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.yan.computerUse.status()
      if (!alive.current) return
      setStatus(next)
      setStatusError('')
    } catch (cause) {
      if (!alive.current) return
      setStatus(null)
      setStatusError(cause instanceof Error ? cause.message : String(cause))
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
    } catch (cause) {
      if (alive.current) setResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
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
    } catch (cause) {
      if (alive.current) setResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (alive.current) setBusy(null)
    }
    if (alive.current) await refresh()
  }

  return (
    <div data-testid="cap-computer-use">
      <Group
        title={t('cu.title')}
        desc={t('cu.desc')}
        actions={
          <Switch
            aria-label={t('cu.title')}
            isSelected={!!status?.enabled}
            isDisabled={!status?.uvx || busy !== null}
            onChange={(next) => void toggle(next)}
            data-testid="cap-computer-use-switch"
          />
        }
      >
        {busy === 'toggle' ? <Meta>{status?.enabled ? t('cu.disabling') : t('cu.preparing')}</Meta> : null}
        {statusError ? <Warn>{statusError}</Warn> : null}
        {status && !status.uvx ? (
          <>
            <Meta>{t('cu.needUv')}</Meta>
            <Actions>
              {status.canInstallUv ? (
                <Button size="sm" variant="primary" isDisabled={busy !== null} onPress={() => void installUv()}>
                  {busy === 'uv' ? t('cu.uvInstalling') : t('cu.installUv')}
                </Button>
              ) : null}
              {!status.canInstallUv || manual ? (
                <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(UV_DOCS)}>
                  {t('cu.uvDocs')}
                </Button>
              ) : null}
            </Actions>
          </>
        ) : null}
        {result ? (result.ok ? <Meta>{result.text}</Meta> : <Warn>{result.text}</Warn>) : null}
        <Meta>{t('cu.scope')}</Meta>
        <Actions>
          <Button size="sm" variant="ghost" isDisabled={busy !== null} onPress={() => void refresh()}>
            {t('set.extRecheck')}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => void window.yan.browser.openExternal(RELEASES)}>
            {t('set.releasePage')}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => void window.yan.browser.openExternal(REPO)}>
            {t('cu.repo')}
          </Button>
        </Actions>
      </Group>
    </div>
  )
}
