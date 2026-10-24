import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import type { PluginCatalogEntry, PluginCatalogText } from '../../../../../shared/plugin-catalog'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../../../../../shared/plugin-market'
import { Button, Notice } from '../../../ui'
import { useConfirm } from './confirm'
import { Entry, Warn } from './parts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusKey(status: MinecraftPluginStatus | null): MessageKey | null {
  if (!status) return null
  if (status.conflict) return 'mcPlugin.statusConflict'
  if (!status.installed) return 'ocp.statusMissing'
  if (!status.skill) return 'mcPlugin.statusNoSkill'
  return status.configured ? 'mcPlugin.statusReady' : 'mcPlugin.statusDisabled'
}

export function MinecraftPluginRow({ entry, copy }: { entry: PluginCatalogEntry; copy: PluginCatalogText }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const [status, setStatus] = useState<MinecraftPluginStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'remove' | ''>('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const alive = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await window.yan.packages.minecraft('status')
      if (alive.current && result.status) setStatus(result.status)
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

  const run = async (kind: 'install' | 'remove', okKey: MessageKey): Promise<void> => {
    setBusy(kind)
    setNote(null)
    try {
      const result: MinecraftPluginResult = await window.yan.packages.minecraft(kind)
      if (!alive.current) return
      if (result.status) setStatus(result.status)
      setNote(result.ok ? { kind: 'ok', text: t(okKey) } : { kind: 'err', text: result.error ?? t('pkg.failed') })
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const installed = status?.installed === true
  const install = async (): Promise<void> => {
    await confirm({
      title: installed ? t('mcPlugin.update') : t('pet.install'),
      body: copy.target ?? copy.desc,
      detail: t('mcPlugin.installConfirm', { dir: status?.pluginDir ?? '' }),
      confirmLabel: installed ? t('mcPlugin.update') : t('pet.install'),
      tone: 'default',
      action: () => run('install', 'mcPlugin.installedOk')
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

  const label = statusKey(status)
  const unavailable = status !== null && !status.bundled

  return (
    <Entry
      testId="caps-market-minecraft"
      name={`${copy.name ?? entry.name}${entry.version ? ` · ${entry.version}` : ''}`}
      meta={[label ? t(label) : null, copy.desc, copy.target, copy.hint]}
      actions={
        <>
          <Button
            variant="secondary"
            isDisabled={!!busy || unavailable || status?.conflict === true}
            onPress={() => void install()}
            data-testid="caps-minecraft-install"
          >
            {busy === 'install' ? t('pkg.working') : installed ? t('mcPlugin.update') : t('pet.install')}
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
      {unavailable ? <Warn>{t('mcPlugin.notBundled')}</Warn> : null}
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
