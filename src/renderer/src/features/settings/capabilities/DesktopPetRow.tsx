import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import { DESKTOP_PET_VERSION, type DesktopPetResult, type DesktopPetStatus } from '../../../../../shared/desktop-pet'
import type { PluginCatalogEntry, PluginCatalogText } from '../../../../../shared/plugin-catalog'
import type { ModelInfo } from '../../../../../shared/ipc'
import { Button, Checkbox, ListBoxItem, Notice, Select } from '../../../ui'
import { useConfirm } from './confirm'
import { Entry, Warn } from './parts'

type RunKind = 'install' | 'start' | 'stop' | 'uninstall' | 'autoStart' | 'model'

const MODEL_OFF = '__off__'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function edgeMeta(edges: DesktopPetStatus['edges'], t: ReturnType<typeof useT>): string | null {
  if (edges.state === 'running') return t('pet.edgesRunning', { done: edges.done, total: edges.total })
  if (edges.state === 'done') return t('pet.edgesDone', { n: edges.total })
  if (edges.state === 'skipped') return t('pet.edgesNoFfmpeg')
  return null
}

export function DesktopPetRow({ entry, copy }: { entry: PluginCatalogEntry; copy: PluginCatalogText }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const [status, setStatus] = useState<DesktopPetStatus | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [busy, setBusy] = useState<RunKind | ''>('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showLog, setShowLog] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.desktopPet.status()
      if (alive.current) setStatus(next)
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    void window.yan
      .listModels()
      .then((list) => {
        if (alive.current) setModels(list)
      })
      .catch(() => undefined)
    return () => {
      alive.current = false
    }
  }, [load])

  const edgesRunning = status?.edges.state === 'running'
  useEffect(() => {
    if (!edgesRunning) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [edgesRunning, load])

  const run = async (kind: RunKind, action: () => Promise<DesktopPetResult>, okKey: MessageKey): Promise<void> => {
    setBusy(kind)
    setNote(null)
    try {
      const result = await action()
      if (!alive.current) return
      if (result.status) setStatus(result.status)
      setNote(result.ok ? { kind: 'ok', text: t(okKey) } : { kind: 'err', text: result.error ?? t('pkg.failed') })
    } catch (error) {
      if (alive.current) setNote({ kind: 'err', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const install = async (): Promise<void> => {
    await confirm({
      title: t('pet.install'),
      body: copy.target ?? copy.desc,
      detail: t('pet.installConfirm', { dir: status?.installDir ?? '' }),
      confirmLabel: t('pet.install'),
      tone: 'default',
      action: () => run('install', () => window.yan.desktopPet.install(), 'pet.installedOk')
    })
  }

  const uninstall = async (): Promise<void> => {
    await confirm({
      title: t('pet.uninstall'),
      body: t('pet.uninstallConfirm'),
      detail: status?.installDir ?? '',
      confirmLabel: t('pet.uninstall'),
      tone: 'danger',
      action: () => run('uninstall', () => window.yan.desktopPet.uninstall(), 'pet.uninstalledOk')
    })
  }

  const installed = status?.installed === true
  const running = status?.running === true
  const label = running ? t('ocp.statusRunning') : installed ? t('ocp.statusStopped') : t('ocp.statusMissing')
  const selectedModel = status?.model ?? MODEL_OFF
  const modelKnown = selectedModel === MODEL_OFF || models.some((model) => `${model.provider}/${model.id}` === selectedModel)

  const metaParts = [
    label,
    copy.desc,
    copy.target,
    installed ? t('pet.firstRun') : null,
    installed && status ? edgeMeta(status.edges, t) : null
  ]

  return (
    <Entry
      testId="caps-market-desktop-pet"
      name={`${copy.name ?? entry.name} · ${status?.version || DESKTOP_PET_VERSION}`}
      meta={metaParts}
      metaTitle={metaParts.filter(Boolean).join(' · ')}
      actions={
        <>
          {!installed ? (
            <Button variant="secondary" isDisabled={!!busy} onPress={() => void install()} data-testid="caps-pet-install">
              {busy === 'install' ? t('pet.installing') : t('pet.install')}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                isDisabled={!!busy}
                onPress={() =>
                  running
                    ? void run('stop', () => window.yan.desktopPet.stop(), 'pet.stoppedOk')
                    : void run('start', () => window.yan.desktopPet.start(), 'pet.startedOk')
                }
                data-testid="caps-pet-toggle"
              >
                {running ? t('ocp.stop') : busy === 'start' ? t('pkg.working') : t('ocp.start')}
              </Button>
              <Button variant="ghost" isDisabled={!!busy} onPress={() => void install()} data-testid="caps-pet-update">
                {busy === 'install' ? t('pet.installing') : t('pet.reinstall')}
              </Button>
            </>
          )}
          {installed && status?.log.length ? (
            <Button variant="ghost" onPress={() => setShowLog((value) => !value)} data-testid="caps-pet-log-toggle">
              {showLog ? t('ocp.hideLog') : t('ocp.showLog')}
            </Button>
          ) : null}
          <Button variant="ghost" onPress={() => void window.yan.browser.openExternal(entry.url)} data-testid="caps-pet-source">
            {t('market.source')}
          </Button>
          {installed ? (
            <Button variant="danger" isDisabled={!!busy} onPress={() => void uninstall()} data-testid="caps-pet-uninstall">
              {t('pet.uninstall')}
            </Button>
          ) : null}
        </>
      }
    >
      {installed && status?.edges.state === 'failed' ? <Warn>{t('pet.edgesFailed', { error: status.edges.message ?? '' })}</Warn> : null}
      {installed ? (
        <div className="caps-field">
          <Select
            label={t('pet.model')}
            description={t('pet.modelHint')}
            selectedKey={modelKnown ? selectedModel : MODEL_OFF}
            isDisabled={!!busy}
            onSelectionChange={(key) => {
              const next = String(key)
              void run('model', () => window.yan.desktopPet.setModel(next === MODEL_OFF ? null : next), 'pet.modelOk')
            }}
            data-testid="caps-pet-model"
          >
            <ListBoxItem key={MODEL_OFF} id={MODEL_OFF}>
              {t('pet.modelOff')}
            </ListBoxItem>
            {models.map((model) => {
              const key = `${model.provider}/${model.id}`
              return (
                <ListBoxItem key={key} id={key}>
                  {`${model.name || model.id} · ${model.provider}`}
                </ListBoxItem>
              )
            })}
          </Select>
        </div>
      ) : null}
      {installed ? (
        <div className="caps-field">
          <Checkbox
            isSelected={status?.autoStart === true}
            isDisabled={!!busy}
            onChange={(next) => void run('autoStart', () => window.yan.desktopPet.autoStart(next), 'ocp.autoStartOk')}
            data-testid="caps-pet-autostart"
          >
            {t('ocp.autoStart')}
          </Checkbox>
        </div>
      ) : null}
      {showLog && status?.log.length ? (
        <pre className="caps-raw" data-testid="caps-pet-log">
          {status.log.slice(-20).join('\n')}
        </pre>
      ) : null}
      {note ? (
        note.kind === 'err' ? (
          <Warn>{note.text}</Warn>
        ) : (
          <Notice tone="ok" compact data-testid="caps-pet-note">
            {note.text}
          </Notice>
        )
      ) : null}
    </Entry>
  )
}
