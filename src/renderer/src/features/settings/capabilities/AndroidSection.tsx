import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import { Button, Meter } from '../../../ui'
import type { AndroidComponentId, AndroidComponentStatus, AndroidSdkStatus } from '../../../../../shared/android-sdk'
import { Entry, Group, Panel, Warn } from './parts'

const APPROX_BYTES: Record<AndroidComponentId, number> = {
  platformTools: 8 * 1024 ** 2,
  emulator: 460 * 1024 ** 2,
  systemImage: 1900 * 1024 ** 2,
  jdk: 200 * 1024 ** 2,
  accel: 1024 ** 2
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

function installable(component: AndroidComponentStatus): boolean {
  return component.state === 'missing'
}

export function AndroidSection(): ReactElement {
  const t = useT()
  const [status, setStatus] = useState<AndroidSdkStatus | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await window.yan.android.status()
      if (alive.current) { setStatus(next); setError('') }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const install = status?.install
  const running = install?.state === 'running'
  useEffect(() => {
    if (!running) return undefined
    const id = window.setInterval(() => void refresh(), 700)
    return () => window.clearInterval(id)
  }, [running, refresh])

  const start = async (ids: AndroidComponentId[]): Promise<void> => {
    const result = await window.yan.android.install(ids)
    if (!result.ok) setError(result.error ?? t('android.installFailed'))
    await refresh()
  }

  const label = (id: AndroidComponentId): string => t(`android.component.${id}` as 'android.component.platformTools')
  const missing = status?.components.filter(installable).map((component) => component.id) ?? []
  const stateText = (component: AndroidComponentStatus): string => {
    if (component.state === 'installed') return t('android.installed')
    if (component.state === 'missing') return t('android.missing')
    if (component.id === 'accel' && component.detail === 'needs-emulator') return t('android.accelNeedsEmulator')
    return component.state === 'unsupported' ? t('android.unsupported') : t('android.unknown')
  }

  return (
    <Panel label={t('android.title')}>
      <div className="caps-stack" data-testid="settings-android" data-setting-id="caps-tools-android">
        <Group
          title={t('android.title')}
          desc={t('android.desc')}
          actions={
            <>
              <Button variant="secondary" onPress={() => void window.yan.android.openSdkDir()}>
                {t('android.openSdk')}
              </Button>
              <Button isDisabled={running || !missing.length} onPress={() => void start(missing)}>
                {missing.length ? t('android.installAll', { size: fmtBytes(missing.reduce((sum, id) => sum + APPROX_BYTES[id], 0)) }) : t('android.allInstalled')}
              </Button>
            </>
          }
        >
          <div className="caps-list">
            {install ? (
              <Entry
                testId="android-install"
                name={
                  install.state === 'running' && install.current
                    ? t('android.installing', { name: label(install.current), index: install.done.length + 1, count: install.queue.length })
                    : install.state === 'done'
                      ? t('android.installDone')
                      : install.state === 'cancelled'
                        ? t('android.installCancelled')
                        : t('android.installFailedMsg', { msg: install.error ?? '' })
                }
                meta={[
                  install.state === 'running'
                    ? install.phase === 'download'
                      ? t('android.progress', { got: fmtBytes(install.received), total: install.total ? fmtBytes(install.total) : '…' })
                      : t(`android.phase.${install.phase}` as 'android.phase.extract')
                    : null
                ]}
                actions={
                  running ? (
                    <Button variant="secondary" onPress={() => void window.yan.android.cancel().then(refresh)}>
                      {t('android.cancel')}
                    </Button>
                  ) : null
                }
              >
                {running ? (
                  <Meter
                    aria-label={t('android.title')}
                    value={install.phase === 'download' ? install.received : install.total || 1}
                    minValue={0}
                    maxValue={install.total || 1}
                  />
                ) : null}
              </Entry>
            ) : null}

            {status?.components.map((component) => (
              <Entry
                key={component.id}
                testId={`android-${component.id}`}
                name={label(component.id)}
                meta={[
                  stateText(component),
                  t(`android.purpose.${component.id}` as 'android.purpose.platformTools'),
                  component.state === 'missing' ? `~${fmtBytes(APPROX_BYTES[component.id])}` : null,
                  component.state === 'installed' && component.path ? component.path : null
                ]}
                metaTitle={component.path ?? component.detail}
                actions={
                  installable(component) ? (
                    <Button variant="secondary" isDisabled={running} onPress={() => void start([component.id])}>
                      {component.id === 'accel' ? t('android.installAdmin') : t('android.install')}
                    </Button>
                  ) : null
                }
              />
            ))}

            {status ? (
              <Entry
                testId="android-sdk-root"
                name={t('android.sdkRoot')}
                meta={[t(`android.source.${status.sdkSource}` as 'android.source.managed'), status.sdkRoot, status.avds.length ? t('android.avds', { list: status.avds.join('、') }) : t('android.noAvds')]}
                metaTitle={status.sdkRoot}
              />
            ) : null}
          </div>
          {error ? <Warn>{error}</Warn> : null}
        </Group>
      </div>
    </Panel>
  )
}
