import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import type { OpenCodeProxyResult, OpenCodeProxyStatus } from '../../../../../shared/opencode-proxy'
import { Button, Checkbox, Notice } from '../../../ui'
import { useConfirm } from './confirm'
import { Entry, Warn } from './parts'

type RunKind = 'install' | 'start' | 'stop' | 'refresh' | 'uninstall' | 'autoStart'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function OpenCodeProxyRow(): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const [status, setStatus] = useState<OpenCodeProxyStatus | null>(null)
  const [busy, setBusy] = useState<RunKind | ''>('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.opencodeProxy.status()
      if (alive.current) setStatus(next)
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  const run = async (
    kind: RunKind,
    action: () => Promise<OpenCodeProxyResult>,
    okKey: MessageKey,
    params?: Record<string, string | number>
  ): Promise<void> => {
    setBusy(kind)
    setNote(null)
    try {
      const result = await action()
      if (!alive.current) return
      if (result.status) setStatus(result.status)
      setNote(result.ok ? { kind: 'ok', text: t(okKey, params) } : { kind: 'err', text: result.error ?? t('pkg.failed') })
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const install = async (): Promise<void> => {
    await confirm({
      title: t('ocp.install'),
      body: t('market.opencodeTarget'),
      detail: t('ocp.installConfirm', { dir: status?.installDir ?? '' }),
      confirmLabel: t('ocp.install'),
      tone: 'default',
      action: () => run('install', () => window.yan.opencodeProxy.install(), 'ocp.installedOk')
    })
  }

  const uninstall = async (): Promise<void> => {
    await confirm({
      title: t('ocp.uninstall'),
      body: t('ocp.uninstallConfirm'),
      detail: status?.installDir ?? '',
      confirmLabel: t('ocp.uninstall'),
      tone: 'danger',
      action: () => run('uninstall', () => window.yan.opencodeProxy.uninstall(), 'ocp.uninstalledOk')
    })
  }

  const copyPassword = (): void => {
    if (!status?.consolePassword) return
    void navigator.clipboard?.writeText(status.consolePassword).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => {
      if (alive.current) setCopied(false)
    }, 2000)
  }

  const installed = status?.installed === true
  const running = status?.running === true
  const label = running ? t('ocp.statusRunning') : installed ? t('ocp.statusStopped') : t('ocp.statusMissing')
  const metaParts = [
    label,
    installed
      ? t('ocp.runtime', {
          version: status?.version ?? '',
          port: status?.port ?? 0,
          n: status?.models.length ?? 0
        })
      : null,
    installed ? t('ocp.license') : null,
    installed ? (status?.providerLinked ? t('ocp.providerLinked') : t('ocp.providerMissing')) : null,
    t('market.opencodeDesc'),
    t('market.opencodeTarget')
  ]

  return (
    <Entry
      testId="caps-market-opencode"
      name={`OpenCode 反代${status?.version ? ` · ${status.version}` : ''}`}
      meta={metaParts}
      metaTitle={metaParts.filter(Boolean).join(' · ')}
      actions={
        <>
          {!installed ? (
            <Button variant="secondary" isDisabled={!!busy} onPress={() => void install()} data-testid="caps-opencode-install">
              {busy === 'install' ? t('ocp.installing') : t('ocp.install')}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                isDisabled={!!busy}
                onPress={() =>
                  running
                    ? void run('stop', () => window.yan.opencodeProxy.stop(), 'ocp.stoppedOk')
                    : void run('start', () => window.yan.opencodeProxy.start(), 'ocp.startedOk')
                }
                data-testid="caps-opencode-toggle"
              >
                {running ? t('ocp.stop') : t('ocp.start')}
              </Button>
              <Button
                variant="ghost"
                isDisabled={!!busy || !running}
                onPress={() => void run('refresh', () => window.yan.opencodeProxy.refresh(), 'ocp.refreshedOk', { n: status?.models.length ?? 0 })}
                data-testid="caps-opencode-refresh"
              >
                {t('ocp.refresh')}
              </Button>
              <Button variant="ghost" isDisabled={!!busy} onPress={() => void install()} data-testid="caps-opencode-update">
                {busy === 'install' ? t('ocp.installing') : t('ocp.update')}
              </Button>
            </>
          )}
          {installed && running ? (
            <Button variant="ghost" onPress={() => void window.yan.browser.openExternal(status?.consoleUrl ?? '')} data-testid="caps-opencode-console">
              {t('ocp.console')}
            </Button>
          ) : null}
          {installed && running && status?.consolePassword ? (
            <Button variant="ghost" onPress={copyPassword} data-testid="caps-opencode-password">
              {copied ? t('ocp.copied') : t('ocp.copyPassword')}
            </Button>
          ) : null}
          {installed && running && status?.log.length ? (
            <Button variant="ghost" onPress={() => setShowLog((value) => !value)} data-testid="caps-opencode-log-toggle">
              {showLog ? t('ocp.hideLog') : t('ocp.showLog')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onPress={() => void window.yan.browser.openExternal('https://github.com/jasonxu114514/opencode2api')}
            data-testid="caps-opencode-source"
          >
            {t('market.source')}
          </Button>
          {installed ? (
            <Button variant="danger" isDisabled={!!busy} onPress={() => void uninstall()} data-testid="caps-opencode-uninstall">
              {t('ocp.uninstall')}
            </Button>
          ) : null}
        </>
      }
    >
      {installed ? (
        <div className="caps-field">
          <Checkbox
            isSelected={status?.autoStart === true}
            isDisabled={!!busy}
            onChange={(next) => void run('autoStart', () => window.yan.opencodeProxy.autoStart(next), 'ocp.autoStartOk')}
            data-testid="caps-opencode-autostart"
          >
            {t('ocp.autoStart')}
          </Checkbox>
        </div>
      ) : null}
      {showLog && status?.log.length ? (
        <pre className="caps-raw" data-testid="caps-opencode-log">
          {status.log.slice(-20).join('\n')}
        </pre>
      ) : null}
      {note ? (
        note.kind === 'err' ? (
          <Warn>{note.text}</Warn>
        ) : (
          <Notice tone="ok" compact data-testid="caps-opencode-note">
            {note.text}
          </Notice>
        )
      ) : null}
    </Entry>
  )
}
