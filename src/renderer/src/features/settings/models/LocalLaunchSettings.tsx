import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { LocalLauncherInput, LocalLauncherModelView, LocalLauncherView, LocalModelInput } from '../../../../../shared/ipc'
import { useT } from '../../../i18n'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import { SettingsGroup, SettingsReveal } from '../root/controls'
import { Badge, Button, Checkbox, CollapsibleChevron, ConfirmDialog, Notice, settingCardClass, Switch, TextField } from '../../../ui'
import { Plus, Trash2 } from '../../../ui/icons'
import './models-settings.css'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`
  return `${Math.round(tokens / 1000)}K`
}

type SharedField = 'command' | 'stopCommand'

interface AddDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  image: boolean
  command: string
}

const EMPTY_ADD: AddDraft = {
  id: '',
  name: '',
  contextWindow: '',
  maxTokens: '',
  reasoning: true,
  image: false,
  command: ''
}

function hasAutoStart(item: LocalLauncherView): boolean {
  return !!item.command || item.models.some((model) => !!model.command)
}

export function LocalLaunchSettings(): ReactElement | null {
  const t = useT()
  const [list, setList] = useState<LocalLauncherView[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [modelCmds, setModelCmds] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [sharedOpen, setSharedOpen] = useState<Record<string, boolean>>({})
  const [addingFor, setAddingFor] = useState<string | null>(null)
  const [addDraft, setAddDraft] = useState<AddDraft>(EMPTY_ADD)
  const [pendingRemove, setPendingRemove] = useState<{ item: LocalLauncherView; model: LocalLauncherModelView } | null>(null)
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

  const draftKey = (provider: string, field: SharedField): string => `${provider}\u0000${field}`
  const valueOf = (item: LocalLauncherView, field: SharedField): string => drafts[draftKey(item.provider, field)] ?? item[field]
  const sharedDirty = (item: LocalLauncherView): boolean =>
    valueOf(item, 'command').trim() !== item.command || valueOf(item, 'stopCommand').trim() !== item.stopCommand
  const modelKey = (provider: string, id: string): string => `${provider}\u0000model\u0000${id}`
  const nameOf = (provider: string, model: LocalLauncherModelView): string => names[modelKey(provider, model.id)] ?? model.name ?? ''
  const modelCmdOf = (provider: string, model: LocalLauncherModelView): string => modelCmds[modelKey(provider, model.id)] ?? model.command
  const modelLabel = (model: LocalLauncherModelView): string => model.name || model.id

  const setDraft = (item: LocalLauncherView, field: SharedField, value: string): void =>
    setDrafts((current) => ({ ...current, [draftKey(item.provider, field)]: value }))

  const clearDrafts = (provider: string): void =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${provider}\u0000`))))

  const clearModelCmd = (key: string): void =>
    setModelCmds(({ [key]: _, ...rest }) => rest)

  const saveShared = async (item: LocalLauncherView, patch: Partial<LocalLauncherInput> = {}): Promise<void> => {
    setBusy(`${item.provider}:save`)
    setMsg(null)
    try {
      const onlyIdle = patch.idleUnload !== undefined && patch.command === undefined && patch.stopCommand === undefined
      const input: LocalLauncherInput = onlyIdle
        ? { idleUnload: patch.idleUnload }
        : {
            command: (patch.command ?? valueOf(item, 'command')).trim(),
            stopCommand: (patch.stopCommand ?? valueOf(item, 'stopCommand')).trim(),
            idleUnload: patch.idleUnload ?? item.idleUnload
          }
      const result = await window.yan.saveLocalLauncher(item.provider, input)
      if (!alive.current) return
      setList(result.launchers)
      if (!onlyIdle) clearDrafts(item.provider)
      const updated = result.launchers.find((entry) => entry.provider === item.provider)
      if (result.warning) setMsg({ kind: 'stall', text: result.warning })
      else if (onlyIdle) setMsg({ kind: 'ok', text: t(patch.idleUnload ? 'localLaunch.idleOn' : 'localLaunch.idleOff', { provider: item.name }) })
      else if (updated && !hasAutoStart(updated)) setMsg({ kind: 'ok', text: t('localLaunch.cleared', { provider: item.name }) })
      else setMsg({ kind: 'ok', text: t('localLaunch.sharedSaved', { provider: item.name }) })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const saveModelCommand = async (item: LocalLauncherView, model: LocalLauncherModelView, commandOverride?: string): Promise<void> => {
    const key = modelKey(item.provider, model.id)
    const command = (commandOverride ?? modelCmdOf(item.provider, model)).trim()
    setBusy(`${key}:save`)
    setMsg(null)
    try {
      const result = await window.yan.saveLocalLauncher(item.provider, { modelId: model.id, modelCommand: command })
      if (!alive.current) return
      setList(result.launchers)
      clearModelCmd(key)
      if (result.warning) setMsg({ kind: 'stall', text: result.warning })
      else setMsg({ kind: 'ok', text: t(command ? 'localLaunch.modelSaved' : 'localLaunch.modelCleared', { model: modelLabel(model) }) })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const chooseShared = async (item: LocalLauncherView, field: SharedField): Promise<void> => {
    setBusy(`${item.provider}:pick`)
    setMsg(null)
    let path: string | null = null
    try {
      path = await window.yan.pickLocalLauncher(valueOf(item, field) || valueOf(item, 'command') || item.models.find((m) => m.command)?.command)
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
    if (path && alive.current) await saveShared(item, { [field]: path })
  }

  const chooseModelCommand = async (item: LocalLauncherView, model: LocalLauncherModelView): Promise<void> => {
    const key = modelKey(item.provider, model.id)
    setBusy(`${key}:pick`)
    setMsg(null)
    let path: string | null = null
    try {
      const near = modelCmdOf(item.provider, model) || item.models.find((m) => m.command)?.command || item.command
      path = await window.yan.pickLocalLauncher(near)
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
    if (path && alive.current) await saveModelCommand(item, model, path)
  }

  const detectShared = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:detect`)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalLauncher(item.provider)
      if (!alive.current) return
      if (found.ok && found.command) {
        setSharedOpen((current) => ({ ...current, [item.provider]: true }))
        setDraft(item, 'command', found.command)
      }
      setMsg({ kind: found.ok ? 'ok' : 'fail', text: found.message })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const detectForModel = async (item: LocalLauncherView, model: LocalLauncherModelView): Promise<void> => {
    const key = modelKey(item.provider, model.id)
    setBusy(`${key}:detect`)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalLauncher(item.provider)
      if (!alive.current) return
      if (found.ok && found.command) {
        setModelCmds((current) => ({ ...current, [key]: found.command! }))
        const running = found.models?.map((m) => m.id) ?? []
        if (running.length && !running.includes(model.id)) {
          setMsg({ kind: 'stall', text: t('localLaunch.detectRunningOther', { running: running.join(' / '), target: model.id }) })
          return
        }
      }
      setMsg({ kind: found.ok ? 'ok' : 'fail', text: found.message })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const detectForAdd = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:add-detect`)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalLauncher(item.provider)
      if (!alive.current) return
      const existing = new Set(item.models.map((m) => m.id))
      const fresh = found.models?.find((m) => !existing.has(m.id))
      const picked = fresh ?? found.models?.[0]
      setAddDraft((current) => ({
        ...current,
        ...(fresh ? {
          id: fresh.id,
          name: fresh.name ?? current.name,
          contextWindow: fresh.contextWindow ? String(fresh.contextWindow) : current.contextWindow,
          reasoning: fresh.reasoning ?? current.reasoning,
          image: fresh.image ?? current.image
        } : {}),
        ...(found.ok && found.command ? { command: found.command } : {})
      }))
      if (fresh && found.ok && found.command) {
        setMsg({ kind: 'ok', text: t('localLaunch.addDetectOk', { model: fresh.id }) })
      } else if (fresh) {
        setMsg({ kind: 'stall', text: t('localLaunch.addDetectModelOnly', { model: fresh.id, detail: found.message }) })
      } else if (picked && found.ok && found.command) {
        setMsg({ kind: 'stall', text: t('localLaunch.addDetectNone') })
      } else {
        setMsg({ kind: found.ok ? 'ok' : 'fail', text: found.message })
      }
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const pickForAdd = async (item: LocalLauncherView): Promise<void> => {
    setBusy(`${item.provider}:add-pick`)
    setMsg(null)
    try {
      const near = addDraft.command || item.models.find((m) => m.command)?.command || item.command
      const path = await window.yan.pickLocalLauncher(near)
      if (path && alive.current) setAddDraft((current) => ({ ...current, command: path }))
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const openAdd = (item: LocalLauncherView): void => {
    if (addingFor === item.provider) {
      setAddingFor(null)
      return
    }
    const sample = item.models[0]
    setAddDraft({
      ...EMPTY_ADD,
      reasoning: sample?.reasoning ?? true,
      image: sample?.input?.includes('image') ?? false,
      maxTokens: sample?.maxTokens ? String(sample.maxTokens) : ''
    })
    setAddingFor(item.provider)
    setMsg(null)
  }

  const submitAdd = async (item: LocalLauncherView): Promise<void> => {
    const id = addDraft.id.trim()
    if (!id) return
    setBusy(`${item.provider}:add`)
    setMsg(null)
    try {
      const contextWindow = Number(addDraft.contextWindow)
      const maxTokens = Number(addDraft.maxTokens)
      const payload: LocalModelInput = {
        id,
        ...(addDraft.name.trim() ? { name: addDraft.name.trim() } : {}),
        ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
        ...(addDraft.reasoning ? { reasoning: true } : {}),
        input: addDraft.image ? ['text', 'image'] : ['text'],
        ...(addDraft.command.trim() ? { command: addDraft.command.trim() } : {})
      }
      const result = await window.yan.addLocalModel(item.provider, payload)
      if (!alive.current) return
      setList(result.launchers)
      setAddingFor(null)
      setAddDraft(EMPTY_ADD)
      setMsg(result.warning ? { kind: 'stall', text: result.warning } : { kind: 'ok', text: t('localLaunch.added', { model: addDraft.name.trim() || id }) })
      refreshModelsAfterRestart()
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (!pendingRemove) return
    const { item, model } = pendingRemove
    setBusy(`${modelKey(item.provider, model.id)}:remove`)
    setMsg(null)
    try {
      const next = await window.yan.removeLocalModel(item.provider, model.id)
      if (!alive.current) return
      setList(next)
      setPendingRemove(null)
      setMsg({ kind: 'ok', text: t('localLaunch.removed', { model: modelLabel(model) }) })
      refreshModelsAfterRestart()
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const rename = async (item: LocalLauncherView, model: LocalLauncherModelView): Promise<void> => {
    const key = modelKey(item.provider, model.id)
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
        <div className={settingCardClass('rows', 'settings-rows ms-rows')}>
          {list.map((item) => {
            const autoStart = hasAutoStart(item)
            const showSharedCmd = !!item.command || !!sharedOpen[item.provider] || drafts[draftKey(item.provider, 'command')] !== undefined
            const adding = addingFor === item.provider
            return (
              <div className="ms-custom-row" key={item.provider} data-testid={`ms-local-launch-row-${item.provider}`}>
                <div className="ms-custom-main ms-local-main">
                  <div className="ms-local-head-row">
                    <div className="ms-local-head">
                      <div className="ms-custom-name">
                        {item.name}
                        <Badge tone={autoStart ? 'accent' : 'neutral'}>
                          {autoStart ? t('localLaunch.on') : t('localLaunch.off')}
                        </Badge>
                      </div>
                      <div className="ms-custom-meta">
                        <span>{item.baseUrl}</span>
                        <span>{t('localLaunch.modelCount', { n: item.models.length })}</span>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      isDisabled={!!busy}
                      icon={<Plus size={13} aria-hidden />}
                      data-testid={`ms-local-add-model-${item.provider}`}
                      onPress={() => openAdd(item)}
                    >
                      {t('localLaunch.addModel')}
                    </Button>
                  </div>

                  <div className="ms-local-models">
                    {item.models.map((model) => {
                      const key = modelKey(item.provider, model.id)
                      const nameVal = nameOf(item.provider, model)
                      const cmdVal = modelCmdOf(item.provider, model)
                      const cmdDirty = cmdVal.trim() !== model.command
                      return (
                        <div className="ms-local-model-card" key={model.id} data-testid={`ms-local-model-${model.id}`}>
                          <div className="ms-local-model-head">
                            <div className="ms-local-model-title">
                              <span className="ms-local-model-name">{modelLabel(model)}</span>
                              {model.name && model.name !== model.id ? <code className="ms-local-model-id">{model.id}</code> : null}
                              {model.contextWindow ? <Badge tone="neutral">{formatContext(model.contextWindow)}</Badge> : null}
                              {model.command ? (
                                <Badge tone="accent">{t('localLaunch.modelBadgeOwn')}</Badge>
                              ) : item.command ? (
                                <Badge tone="neutral">{t('localLaunch.modelBadgeDefault')}</Badge>
                              ) : null}
                            </div>
                            {item.models.length > 1 ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                isDisabled={!!busy}
                                icon={<Trash2 size={13} aria-hidden />}
                                data-testid={`ms-local-model-remove-${model.id}`}
                                onPress={() => setPendingRemove({ item, model })}
                              >
                                {t('localLaunch.removeModel')}
                              </Button>
                            ) : null}
                          </div>

                          <div className="ms-local-model">
                            <TextField
                              label={t('localLaunch.modelsHint')}
                              aria-label={t('localLaunch.modelName', { id: model.id })}
                              placeholder={model.id}
                              value={nameVal}
                              isDisabled={!!busy}
                              onChange={(next) => setNames((current) => ({ ...current, [key]: next }))}
                              inputClassName="ms-custom-input"
                            />
                            <Button
                              variant="secondary"
                              isDisabled={!!busy || nameVal.trim() === (model.name ?? '')}
                              data-testid={`ms-local-model-rename-${model.id}`}
                              onPress={() => void rename(item, model)}
                            >
                              {t('localLaunch.rename')}
                            </Button>
                          </div>

                          <div className="ms-local-model">
                            <TextField
                              label={t('localLaunch.command')}
                              placeholder={item.command ? t('localLaunch.modelCommandPlaceholderFallback') : t('localLaunch.placeholder')}
                              value={cmdVal}
                              isDisabled={!!busy}
                              onChange={(next) => setModelCmds((current) => ({ ...current, [key]: next }))}
                              inputClassName="ms-custom-input"
                            />
                            <Button
                              variant="secondary"
                              isDisabled={!!busy}
                              data-testid={`ms-local-model-pick-${model.id}`}
                              onPress={() => void chooseModelCommand(item, model)}
                            >
                              {t('localLaunch.pick')}
                            </Button>
                          </div>

                          <div className="ms-custom-actions">
                            <Button
                              variant="secondary"
                              size="sm"
                              isDisabled={!!busy}
                              data-testid={`ms-local-model-detect-${model.id}`}
                              onPress={() => void detectForModel(item, model)}
                            >
                              {busy === `${key}:detect` ? t('localLaunch.detecting') : t('localLaunch.detect')}
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              isDisabled={!!busy || !cmdDirty}
                              data-testid={`ms-local-model-save-${model.id}`}
                              onPress={() => void saveModelCommand(item, model)}
                            >
                              {t('localLaunch.save')}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {adding ? (
                    <div className={settingCardClass('form', 'ms-custom-form ms-local-add-form')} data-testid={`ms-local-add-form-${item.provider}`}>
                      <div className="ms-local-add-head">
                        <span className="ms-local-shared-title">{t('localLaunch.addTitle', { provider: item.name })}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          isDisabled={!!busy}
                          data-testid={`ms-local-add-detect-${item.provider}`}
                          onPress={() => void detectForAdd(item)}
                        >
                          {busy === `${item.provider}:add-detect` ? t('localLaunch.detecting') : t('localLaunch.addDetect')}
                        </Button>
                      </div>
                      <div className="ms-local-add-grid">
                        <TextField
                          label={t('localLaunch.addId')}
                          placeholder={t('localLaunch.addIdPlaceholder')}
                          value={addDraft.id}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, id: value }))}
                          inputClassName="ms-custom-input"
                        />
                        <TextField
                          label={t('localLaunch.addName')}
                          placeholder={t('localLaunch.addNamePlaceholder')}
                          value={addDraft.name}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, name: value }))}
                          inputClassName="ms-custom-input"
                        />
                        <TextField
                          label={t('localLaunch.addContext')}
                          placeholder="49152"
                          type="number"
                          value={addDraft.contextWindow}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, contextWindow: value }))}
                          inputClassName="ms-custom-input"
                        />
                        <TextField
                          label={t('localLaunch.addMaxTokens')}
                          placeholder="8192"
                          type="number"
                          value={addDraft.maxTokens}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, maxTokens: value }))}
                          inputClassName="ms-custom-input"
                        />
                      </div>
                      <div className="ms-local-add-checks">
                        <Checkbox
                          isSelected={addDraft.reasoning}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, reasoning: value }))}
                        >
                          {t('localLaunch.addReasoning')}
                        </Checkbox>
                        <Checkbox
                          isSelected={addDraft.image}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, image: value }))}
                        >
                          {t('localLaunch.addImage')}
                        </Checkbox>
                      </div>
                      <div className="ms-local-model">
                        <TextField
                          label={t('localLaunch.addCommand')}
                          placeholder={t('localLaunch.placeholder')}
                          value={addDraft.command}
                          isDisabled={!!busy}
                          onChange={(value) => setAddDraft((current) => ({ ...current, command: value }))}
                          inputClassName="ms-custom-input"
                        />
                        <Button
                          variant="secondary"
                          isDisabled={!!busy}
                          data-testid={`ms-local-add-pick-${item.provider}`}
                          onPress={() => void pickForAdd(item)}
                        >
                          {t('localLaunch.pick')}
                        </Button>
                      </div>
                      <div className="ms-custom-actions">
                        <span className="ms-custom-spacer" />
                        <Button variant="secondary" isDisabled={!!busy} onPress={() => setAddingFor(null)}>
                          {t('ui.cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          isDisabled={!!busy || !addDraft.id.trim()}
                          data-testid={`ms-local-add-submit-${item.provider}`}
                          onPress={() => void submitAdd(item)}
                        >
                          {t('localLaunch.addSubmit')}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="ms-local-section ms-local-shared">
                    <span className="ms-local-shared-title">{t('localLaunch.sharedTitle')}</span>
                    <div className="ms-local-model">
                      <TextField
                        label={t('localLaunch.stopCommand')}
                        placeholder={t('localLaunch.stopPlaceholder')}
                        value={valueOf(item, 'stopCommand')}
                        isDisabled={!!busy}
                        onChange={(value) => setDraft(item, 'stopCommand', value)}
                        inputClassName="ms-custom-input"
                      />
                      <Button
                        variant="secondary"
                        isDisabled={!!busy}
                        data-testid={`ms-local-launch-pick-stop-${item.provider}`}
                        onPress={() => void chooseShared(item, 'stopCommand')}
                      >
                        {t('localLaunch.pick')}
                      </Button>
                    </div>

                    <SettingsReveal open={showSharedCmd}>
                      <div className="ms-local-shared-cmd">
                        <div className="ms-local-model">
                          <TextField
                            label={t('localLaunch.sharedCommand')}
                            placeholder={t('localLaunch.sharedCommandPlaceholder')}
                            value={valueOf(item, 'command')}
                            isDisabled={!!busy}
                            onChange={(value) => setDraft(item, 'command', value)}
                            inputClassName="ms-custom-input"
                          />
                          <Button
                            variant="secondary"
                            isDisabled={!!busy}
                            data-testid={`ms-local-launch-pick-${item.provider}`}
                            onPress={() => void chooseShared(item, 'command')}
                          >
                            {t('localLaunch.pick')}
                          </Button>
                        </div>
                      </div>
                    </SettingsReveal>

                    <div className="ms-custom-actions">
                      {!item.command ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<CollapsibleChevron expanded={showSharedCmd} />}
                          aria-expanded={showSharedCmd}
                          onPress={() => setSharedOpen((current) => ({ ...current, [item.provider]: !showSharedCmd }))}
                        >
                          {showSharedCmd ? t('localLaunch.hideSharedCommand') : t('localLaunch.showSharedCommand')}
                        </Button>
                      ) : null}
                      {showSharedCmd ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          isDisabled={!!busy}
                          data-testid={`ms-local-launch-detect-${item.provider}`}
                          onPress={() => void detectShared(item)}
                        >
                          {busy === `${item.provider}:detect` ? t('localLaunch.detecting') : t('localLaunch.detect')}
                        </Button>
                      ) : null}
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={!!busy || !sharedDirty(item)}
                        data-testid={`ms-local-launch-save-${item.provider}`}
                        onPress={() => void saveShared(item)}
                      >
                        {t('localLaunch.save')}
                      </Button>
                    </div>
                  </div>

                  <div className="ms-local-section ms-local-section--tight">
                    <Switch
                      isSelected={autoStart && item.idleUnload}
                      isDisabled={!!busy || !autoStart}
                      data-testid={`ms-local-launch-idle-${item.provider}`}
                      onChange={(value) => void saveShared(item, { idleUnload: value })}
                    >
                      {t('localLaunch.idleUnload')}
                    </Switch>
                    <p className="ms-note">{t(autoStart ? (item.stopCommand ? 'localLaunch.idleHintStop' : 'localLaunch.idleHintKill') : 'localLaunch.idleNeedsCommand')}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {msg ? (
        <Notice tone={msg.kind} className="ms-msg" data-testid="ms-local-launch-msg">
          {msg.text}
        </Notice>
      ) : null}
      {pendingRemove ? (
        <ConfirmDialog
          overlayClassName="settings-confirm-overlay"
          isOpen
          onOpenChange={(open) => {
            if (!open) setPendingRemove(null)
          }}
          title={t('localLaunch.removeTitle')}
          description={t('localLaunch.removeBody')}
          tone="danger"
          cancelLabel={t('ui.cancel')}
          confirmLabel={t('localLaunch.removeModel')}
          confirmTestId="ms-local-remove-confirm"
          isConfirmDisabled={!!busy}
          closeOnConfirm={false}
          onConfirm={() => void confirmRemove()}
        >
          <p className="settings-confirm-target">{modelLabel(pendingRemove.model)} ({pendingRemove.model.id})</p>
        </ConfirmDialog>
      ) : null}
    </SettingsGroup>
  )
}
