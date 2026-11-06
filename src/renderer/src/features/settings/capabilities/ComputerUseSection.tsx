import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { ComputerUseStatusView } from '../../../../../shared/ipc'
import { MoreHorizontal } from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Switch } from '../../../ui'
import { SettingsGroup, SettingsRow } from '../root/controls'
import { Actions, Meta, Warn } from './parts'

const REPO = 'https://github.com/cursortouch/windows-mcp'
const UV_DOCS = 'https://docs.astral.sh/uv/getting-started/installation/'
const RELEASES = 'https://pypi.org/project/windows-mcp/#history'

export function ComputerUseSection(): ReactElement | null {
  const t = useT()
  const [status, setStatus] = useState<ComputerUseStatusView | null>(null)
  const [busy, setBusy] = useState<'uv' | 'toggle' | 'resolve' | null>(null)
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

  const resolveInteraction = async (): Promise<void> => {
    setBusy('resolve')
    try {
      const next = await window.yan.computerUse.resolveInteraction()
      if (alive.current) setStatus(next)
    } catch (cause) {
      if (alive.current) setResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  return (
    <div data-testid="cap-computer-use" data-setting-id="caps-tools-computer-use">
      <SettingsGroup label={t('cu.title')}>
        <SettingsRow label={t('cu.title')} description={t('cu.desc')}>
          <MenuTrigger>
            <IconButton size="sm" aria-label={t('cu.more')} tooltip={t('cu.more')} data-testid="cap-computer-use-more">
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
            <Popover placement="bottom end">
              <Menu
                aria-label={t('cu.more')}
                onAction={(key) => {
                  if (key === 'recheck') void refresh()
                  else void window.yan.browser.openExternal(key === 'releases' ? RELEASES : REPO)
                }}
                disabledKeys={busy !== null ? ['recheck'] : []}
              >
                <MenuItem id="recheck">{t('set.extRecheck')}</MenuItem>
                <MenuItem id="releases">{t('set.releasePage')}</MenuItem>
                <MenuItem id="repo">{t('cu.repo')}</MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
          <Switch
            aria-label={t('cu.title')}
            isSelected={!!status?.enabled}
            isDisabled={!status?.uvx || busy !== null}
            onChange={(next) => void toggle(next)}
            data-testid="cap-computer-use-switch"
          />
        </SettingsRow>
        {busy === 'toggle' ? <Meta>{status?.enabled ? t('cu.disabling') : t('cu.preparing')}</Meta> : null}
        {statusError ? <Warn>{statusError}</Warn> : null}
        {status && !status.uvx ? (
          <>
            <Meta>{t('cu.needUv')}</Meta>
            <Actions>
              {status.canInstallUv ? (
                <Button variant="secondary" isDisabled={busy !== null} onPress={() => void installUv()}>
                  {busy === 'uv' ? t('cu.uvInstalling') : t('cu.installUv')}
                </Button>
              ) : null}
              {!status.canInstallUv || manual ? (
                <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(UV_DOCS)}>
                  {t('cu.uvDocs')}
                </Button>
              ) : null}
            </Actions>
          </>
        ) : null}
        {result ? (result.ok ? <Meta>{result.text}</Meta> : <Warn>{result.text}</Warn>) : null}
        {status?.interactionUncertain ? (
          <>
            <Warn>{t('cu.uncertain')}</Warn>
            <Actions>
              <Button
                variant="secondary"
                isDisabled={busy !== null}
                isPending={busy === 'resolve'}
                onPress={() => void resolveInteraction()}
                data-testid="cap-computer-use-resolve"
              >
                {t('cu.resolveUncertain')}
              </Button>
            </Actions>
          </>
        ) : null}
      </SettingsGroup>
    </div>
  )
}
