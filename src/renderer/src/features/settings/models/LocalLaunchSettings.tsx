import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { LocalLauncherInput, LocalLauncherView } from '../../../../../shared/ipc'
import { useT } from '../../../i18n'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import { SettingsGroup } from '../root/controls'
import { Badge, Button, Notice, Switch, TextField } from '../../../ui'
import './models-settings.css'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Field = 'command' | 'stopCommand'

export function LocalLaunchSettings(): ReactElement | null {
  const t = useT()
  const [list, setList] = useState<LocalLauncherView[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail' | 'stall'; text: string } | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    window.yan.localLaunchers()
      .then((next) => {
        if (alive.current) setList(next)
      })
      .catch((error: unknown) => {
        if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
      })
    return () => {
      alive.current = false
    }
  }, [])

  if (!list?.length && !msg) return null

  const draftKey = (provider: string, field: Field): string => `${provider}\u0000${field}`
  const valueOf = (item: LocalLauncherView, field: Field): string => drafts[draftKey(item.provider, field)] ?? item[field]
  const dirty = (item: LocalLauncherView): boolean => valueOf(item, 'command').trim() !== item.command || valueOf(item, 'stopCommand').trim() !== item.stopCommand
  const nameKey = (provider: string, id: string): string => `${provider}\u0000model\u0000${id}`
  const nameOf = (provider: string, model: { id: string; name?: string }): string => names[nameKey(provider, model.id)] ?? model.name ?? ''

  const setDraft = (item: LocalLauncherView, field: Field, value: string): void =>
    setDrafts((current) => ({ ...current, [draftKey(item.provider, field)]: value }))

  const clearDrafts = (provider: string): void =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${provider}\u0000`))))

  const save = async (item: LocalLauncherView, patch: Partial<LocalLauncherInput> = {}): Promise<void> => {
    setBusy(`${item.provider}:save`)
    setMsg(null)
    try {
      const input: LocalLauncherInput = {
        command: (patch.command ?? valueOf(item, 'command')).trim(),
        stopCommand: (patch.stopCommand ?? valueOf(item, 'stopCommand')).trim(),
        idleUnload: patch.idleUnload ?? item.idleUnload
      }
      const result = await window.yan.saveLocalLauncher(item.provider, input)
      if (!alive.current) return
      setList(result.launchers)
      clearDrafts(item.provider)
      if (result.warning) setMsg({ kind: 'stall', text: result.warning })
      else if (patch.idleUnload !== undefined) setMsg({ kind: 'ok', text: t(patch.idleUnload ? 'localLaunch.idleOn' : 'localLaunch.idleOff', { provider: item.name }) })
      else setMsg({ kind: 'ok', text: t(input.command ? 'localLaunch.saved' : 'localLaunch.cleared', { provider: item.name }) })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const choose = async (item: LocalLauncherView, field: Field): Promise<void> => {
    setBusy(`${item.provider}:pick`)
    setMsg(null)
    let path: string | null = null
    try {
      path = await window.yan.pickLocalLauncher(valueOf(item, field) || valueOf(item, 'command'))
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
    if (path && alive.current) await save(item, { [field]: path })
  }

  const detect = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:detect`)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalLauncher(item.provider)
      if (!alive.current) return
      if (found.ok && found.command) setDraft(item, 'command', found.command)
      setMsg({ kind: found.ok ? 'ok' : 'fail', text: found.message })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const rename = async (item: LocalLauncherView, model: { id: string; name?: string }): Promise<void> => {
    const key = nameKey(item.provider, model.id)
    setBusy(`${key}:rename`)
    setMsg(null)
    try {
      const name = nameOf(item.provider, model).trim()
      const next = await window.yan.renameLocalModel(item.provider, model.id, name)
      if (!alive.current) return
      setList(next)
      setNames(({ [key]: _, ...rest }) => rest)
      setMsg({ kind: 'ok', text: t('localLaunch.renamed', { model: name || model.id }) })
      refreshModelsAfterRestart()
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const commandRow = (item: LocalLauncherView, field: Field): ReactElement => (
    <div className="ms-local-model">
      <TextField
        label={t(field === 'command' ? 'localLaunch.command' : 'localLaunch.stopCommand')}
        placeholder={t(field === 'command' ? 'localLaunch.placeholder' : 'localLaunch.stopPlaceholder')}
        value={valueOf(item, field)}
        isDisabled={!!busy}
        onChange={(value) => setDraft(item, field, value)}
        inputClassName="ms-custom-input"
      />
      <Button
        variant="secondary"
        isDisabled={!!busy}
        data-testid={`ms-local-launch-${field === 'command' ? 'pick' : 'pick-stop'}-${item.provider}`}
        onPress={() => void choose(item, field)}
      >
        {t('localLaunch.pick')}
      </Button>
    </div>
  )

  return (
    <SettingsGroup
      title={t('localLaunch.title')}
      description={t('localLaunch.desc')}
      settingId="models-local-launch"
      testId="ms-local-launch"
      className="ms-custom"
      plain
    >
      {list?.length ? (
        <div className="settings-rows ms-rows">
          {list.map((item) => (
            <div className="ms-custom-row" key={item.provider} data-testid={`ms-local-launch-row-${item.provider}`}>
              <div className="ms-custom-main">
                <div className="ms-custom-name">
                  {item.name}
                  <Badge tone={item.command ? 'accent' : 'neutral'}>
                    {item.command ? t('localLaunch.on') : t('localLaunch.off')}
                  </Badge>
                </div>
                <div className="ms-custom-meta">
                  <span>{item.baseUrl}</span>
                </div>
                {commandRow(item, 'command')}
                {commandRow(item, 'stopCommand')}
                <div className="ms-custom-actions">
                  <Button
                    variant="secondary"
                    isDisabled={!!busy}
                    data-testid={`ms-local-launch-detect-${item.provider}`}
                    onPress={() => void detect(item)}
                  >
                    {busy === `${item.provider}:detect` ? t('localLaunch.detecting') : t('localLaunch.detect')}
                  </Button>
                  <Button
                    variant="primary"
                    isDisabled={!!busy || !dirty(item)}
                    data-testid={`ms-local-launch-save-${item.provider}`}
                    onPress={() => void save(item)}
                  >
                    {t('localLaunch.save')}
                  </Button>
                </div>
                <Switch
                  isSelected={!!item.command && item.idleUnload}
                  isDisabled={!!busy || !item.command}
                  data-testid={`ms-local-launch-idle-${item.provider}`}
                  onChange={(value) => void save(item, { idleUnload: value })}
                >
                  {t('localLaunch.idleUnload')}
                </Switch>
                <p className="ms-note">{t(item.command ? (item.stopCommand ? 'localLaunch.idleHintStop' : 'localLaunch.idleHintKill') : 'localLaunch.idleNeedsCommand')}</p>
                {item.models.length ? <p className="ms-note">{t('localLaunch.modelsHint')}</p> : null}
                {item.models.map((model) => {
                  const key = nameKey(item.provider, model.id)
                  const value = nameOf(item.provider, model)
                  return (
                    <div className="ms-local-model" key={model.id} data-testid={`ms-local-model-${model.id}`}>
                      <TextField
                        aria-label={t('localLaunch.modelName', { id: model.id })}
                        placeholder={model.id}
                        value={value}
                        isDisabled={!!busy}
                        onChange={(next) => setNames((current) => ({ ...current, [key]: next }))}
                        inputClassName="ms-custom-input"
                      />
                      <Button
                        variant="secondary"
                        isDisabled={!!busy || value.trim() === (model.name ?? '')}
                        data-testid={`ms-local-model-rename-${model.id}`}
                        onPress={() => void rename(item, model)}
                      >
                        {t('localLaunch.rename')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {msg ? (
        <Notice tone={msg.kind} className="ms-msg" data-testid="ms-local-launch-msg">
          {msg.text}
        </Notice>
      ) : null}
    </SettingsGroup>
  )
}
