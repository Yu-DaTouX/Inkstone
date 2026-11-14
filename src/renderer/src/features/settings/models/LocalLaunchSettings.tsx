import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { LocalLauncherView } from '../../../../../shared/ipc'
import { useT } from '../../../i18n'
import { SettingsGroup } from '../root/controls'
import { Badge, Button, Notice, TextField } from '../../../ui'
import './models-settings.css'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LocalLaunchSettings(): ReactElement | null {
  const t = useT()
  const [list, setList] = useState<LocalLauncherView[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null)
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

  const valueOf = (item: LocalLauncherView): string => drafts[item.provider] ?? item.command

  const save = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:save`)
    setMsg(null)
    try {
      const command = valueOf(item).trim()
      const next = await window.yan.saveLocalLauncher(item.provider, command)
      if (!alive.current) return
      setList(next)
      setDrafts(({ [item.provider]: _, ...rest }) => rest)
      setMsg({ kind: 'ok', text: t(command ? 'localLaunch.saved' : 'localLaunch.cleared', { provider: item.name }) })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const detect = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:detect`)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalLauncher(item.provider)
      if (!alive.current) return
      if (found.ok && found.command) setDrafts((current) => ({ ...current, [item.provider]: found.command ?? '' }))
      setMsg({ kind: found.ok ? 'ok' : 'fail', text: found.message })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

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
                <TextField
                  aria-label={t('localLaunch.command')}
                  placeholder={t('localLaunch.placeholder')}
                  value={valueOf(item)}
                  isDisabled={!!busy}
                  onChange={(value) => setDrafts((current) => ({ ...current, [item.provider]: value }))}
                  inputClassName="ms-custom-input"
                />
              </div>
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
                  isDisabled={!!busy || valueOf(item).trim() === item.command}
                  data-testid={`ms-local-launch-save-${item.provider}`}
                  onPress={() => void save(item)}
                >
                  {t('localLaunch.save')}
                </Button>
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
