import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import type { PluginCatalogEntry, PluginCatalogText } from '../../../../../shared/plugin-catalog'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../../../../../shared/plugin-market'
import { Button, Checkbox, Notice, Switch } from '../../../ui'
import { notifyMcpSettingsChanged } from '../../../state/mcp-settings'
import { useConfirm } from './confirm'
import { Entry, StatusBadge, Warn } from './parts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function incomplete(status: MinecraftPluginStatus): boolean {
  return !status.registered || ((!status.split || status.devEnabled === true) && !status.skill)
}

function statusKey(status: MinecraftPluginStatus | null): MessageKey | null {
  if (!status) return null
  if (status.conflict) return 'mcPlugin.statusConflict'
  if (!status.installed) return 'ocp.statusMissing'
  if (incomplete(status)) return 'mcPlugin.statusNoSkill'
  return status.configured ? 'mcPlugin.statusReady' : 'mcPlugin.statusDisabled'
}

let lastMinecraftStatus: MinecraftPluginStatus | null = null

export function MinecraftPluginRow({ entry, copy }: { entry: PluginCatalogEntry; copy: PluginCatalogText }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const [status, setStatus] = useState<MinecraftPluginStatus | null>(lastMinecraftStatus)
  const [busy, setBusy] = useState<'status' | 'install' | 'remove' | 'enable-dev' | 'disable-dev' | 'toggle' | ''>('status')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const alive = useRef(true)

  const load = useCallback(async (manual = false): Promise<void> => {
    setBusy('status')
    setNote(null)
    try {
      const result = await window.yan.packages.minecraft('status')
      if (!alive.current) return
      if (result.status) {
        lastMinecraftStatus = result.status
        setStatus(result.status)
      }
      if (!result.ok) setNote({ kind: 'err', text: result.error ?? t('pkg.failed') })
      else if (manual && result.status?.installed && result.status.installedVersion === result.status.latestVersion) setNote({ kind: 'ok', text: t('mcPlugin.upToDate') })
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }, [t])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  const run = async (kind: 'install' | 'remove' | 'enable-dev' | 'disable-dev', okKey: MessageKey, releaseKey?: string, keepDev?: boolean): Promise<void> => {
    setBusy(kind)
    setNote(null)
    try {
      const result: MinecraftPluginResult = await window.yan.packages.minecraft(kind, releaseKey, keepDev)
      if (!alive.current) return
      if (result.status) {
        lastMinecraftStatus = kind === 'enable-dev' || kind === 'disable-dev' ? { ...status, ...result.status } : result.status
        setStatus(lastMinecraftStatus)
      }
      if (result.ok) notifyMcpSettingsChanged()
      setNote(result.ok ? { kind: 'ok', text: t(okKey) } : { kind: 'err', text: result.error ?? t('pkg.failed') })
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const installed = status?.installed === true
  const install = async (): Promise<void> => {
    const releaseKey = status?.releaseKey
    const version = status?.latestVersion
    if (!releaseKey || !version) return
    let keepDev = false
    await confirm({
      title: t(primaryLabel),
      body: copy.target ?? copy.desc,
      detail: t('mcPlugin.installConfirm', { dir: status?.pluginDir ?? '', version }),
      confirmLabel: t(primaryLabel),
      tone: 'default',
      extra: status?.configured && !status.split && updatable ? <Checkbox onChange={(value) => { keepDev = value }}>{t('mcPlugin.keepDev')}</Checkbox> : undefined,
      action: () => run('install', 'mcPlugin.installedOk', releaseKey, keepDev)
    })
  }

  const remove = async (): Promise<void> => {
    await confirm({
      title: t('mcPlugin.remove'),
      body: t('mcPlugin.removeConfirm'),
      detail: status?.pluginDir ?? '',
      confirmLabel: t('mcPlugin.remove'),
      tone: 'danger',
      action: () => run('remove', 'mcPlugin.removedOk')
    })
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (!status?.registered || busy) return
    setBusy('toggle')
    setNote(null)
    try {
      const snapshot = await window.yan.capabilities.mcpServices()
      const service = snapshot.global.find((item) => item.name === 'inkstone-minecraft' && item.pluginManaged && !item.conflict)
      if (!service) throw new Error(t('mcPlugin.serviceUnavailable'))
      const result = await window.yan.capabilities.changeMcpService({ scope: 'global', context: snapshot.context, revision: snapshot.revision, key: service.key, action: enabled ? 'enable' : 'disable' })
      if (!result.ok) throw new Error(result.error ?? t('pkg.failed'))
      notifyMcpSettingsChanged()
      if (alive.current) {
        lastMinecraftStatus = { ...status, configured: enabled }
        setStatus(lastMinecraftStatus)
        setNote({ kind: 'ok', text: t('mcPlugin.switchSaved') })
      }
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const label = statusKey(status)
  const installedVersion = status?.installedVersion
  const latestVersion = status?.latestVersion
  const updatable = status?.updateAvailable === true && !!latestVersion
  const canInstall = !!status?.releaseKey && !status.conflict && (!installed || updatable || (latestVersion === installedVersion && incomplete(status)))
  const installing = busy === 'install' || canInstall
  const primaryLabel = installed ? updatable ? 'mcPlugin.update' : 'mcPlugin.repair' : 'pet.install'

  return (
    <Entry
      testId="caps-market-minecraft"
      name={status?.split ? t('mcPlugin.mapName') : copy.name ?? entry.name}
      control={installed && status?.registered && !status.conflict ? <Switch aria-label={t('mcPlugin.enableGlobal')} isSelected={status.configured} isDisabled={!!busy} onChange={(enabled) => void setEnabled(enabled)} data-testid="caps-minecraft-toggle" /> : undefined}
      badge={label ? <StatusBadge tone={label === 'mcPlugin.statusReady' ? 'ok' : label === 'mcPlugin.statusConflict' ? 'fail' : 'neutral'}>{t(label)}</StatusBadge> : undefined}
      meta={[
        installedVersion ? t('mcPlugin.installedVersion', { version: installedVersion }) : null,
        updatable ? t('mcPlugin.latestVersion', { version: latestVersion }) : null,
        status?.split ? t('mcPlugin.mapDesc') : copy.desc
      ]}
      metaTitle={status?.split ? t('mcPlugin.mapDesc') : [copy.desc, copy.target, copy.hint].filter(Boolean).join('\n')}
      actions={
        <>
          <Button
            variant="secondary"
            isDisabled={!!busy || status?.conflict === true}
            onPress={() => void (canInstall ? install() : load(true))}
            data-testid={installing ? 'caps-minecraft-install' : 'caps-minecraft-check'}
          >
            {busy === 'install' || busy === 'status' ? t('pkg.working') : installing ? t(primaryLabel) : t('mcPlugin.checkUpdate')}
          </Button>
          <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(entry.url)} data-testid="caps-minecraft-source">
            {t('market.source')}
          </Button>
          {installed ? (
            <Button variant="danger" isDisabled={!!busy} onPress={() => void remove()} data-testid="caps-minecraft-remove">
              {busy === 'remove' ? t('pkg.working') : t('mcPlugin.remove')}
            </Button>
          ) : null}
        </>
      }
    >
      {status?.split ? <Switch isDisabled={!!busy || status.devConflict} isSelected={status.devEnabled === true} data-testid="caps-minecraft-dev-toggle"
        onChange={(enabled) => void run(enabled ? 'enable-dev' : 'disable-dev', 'mcPlugin.switchSaved')}>{t('mcPlugin.enableDev')}</Switch> : null}
      {status?.devConflict ? <Warn>{t('mcPlugin.devConflict')}</Warn> : null}
      {note ? (
        note.kind === 'err' ? (
          <Warn>{note.text}</Warn>
        ) : (
          <Notice tone="ok" compact data-testid="caps-minecraft-note">
            {note.text}
          </Notice>
        )
      ) : null}
    </Entry>
  )
}
