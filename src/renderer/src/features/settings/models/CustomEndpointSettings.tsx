import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  CustomProviderInput,
  CustomProviderTestResult,
  CustomProviderView,
  LocalModelServer,
  ModelsShrink
} from '../../../../../shared/ipc'
import { CUSTOM_API_CHOICES, type CustomProviderModel } from '../../../../../shared/custom-provider'
import { useT } from '../../../i18n'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import { mergeDiscoveredModels } from './models-model'
import { SettingsGroup, SettingsReveal } from '../root/controls'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Notice,
  Select,
  TextField
} from '../../../ui'
import './models-settings.css'

function apiLabel(id: string): string {
  return CUSTOM_API_CHOICES.find((choice) => choice.id === id)?.label ?? id
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CustomEndpointSettings(): ReactElement {
  const t = useT()
  const [list, setList] = useState<CustomProviderView[] | null>(null)
  const [draft, setDraft] = useState<CustomProviderInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [locals, setLocals] = useState<LocalModelServer[] | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<CustomProviderView | null>(null)
  const [pendingShrink, setPendingShrink] = useState<ModelsShrink[] | null>(null)
  const [testId, setTestId] = useState<string | null>(null)
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState<{ id: string; result: CustomProviderTestResult } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.customProviders()
      if (alive.current) setList(next)
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const blank = (): CustomProviderInput => ({
    id: 'yan-',
    api: 'openai-completions',
    baseUrl: '',
    models: [{ id: '' }]
  })

  const beginDraft = (next: CustomProviderInput): void => {
    setDraft(next)
    setMsg(null)
    setTestId(null)
  }

  const cancelDraft = (): void => {
    setDraft(null)
    setMsg(null)
  }

  const patchModel = (index: number, patch: Partial<CustomProviderModel>): void => {
    setDraft((current) =>
      current ? { ...current, models: current.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) } : current
    )
  }

  const save = async (confirmShrink = false): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setMsg(null)
    setPendingShrink(null)
    try {
      const result = await window.yan.saveCustomProvider({
        ...draft,
        ...(draft.apiKey && draft.apiKey.trim() ? {} : { apiKey: undefined }),
        ...(confirmShrink ? { confirmShrink: true } : {})
      })
      if (!alive.current) return
      if (!result.ok && result.shrink?.length) {
        setPendingShrink(result.shrink)
        return
      }
      if (!result.ok) {
        setMsg({ kind: 'fail', text: (result.errors ?? []).join('；') })
        return
      }
      setList(result.providers ?? [])
      setDraft(null)
      setMsg({ kind: 'ok', text: t('customApi.saved') })
      refreshModelsAfterRestart()
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const remove = async (item: CustomProviderView): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.yan.removeCustomProvider(item.id)
      if (!alive.current) return
      if (!result.ok) {
        setMsg({ kind: 'fail', text: (result.errors ?? []).join('；') })
        return
      }
      setList(result.providers ?? [])
      if (draft?.id === item.id) cancelDraft()
      setMsg({ kind: 'ok', text: t('customApi.removed') })
      refreshModelsAfterRestart()
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setBusy(false)
      setPendingRemove(null)
    }
  }

  const fetchModels = async (): Promise<void> => {
    if (!draft) return
    setFetching(true)
    setMsg(null)
    try {
      const found = await window.yan.discoverCustomModels(draft)
      if (!found.ok) {
        setMsg({ kind: 'fail', text: found.message })
        return
      }
      const entries: CustomProviderModel[] = found.entries ?? found.models.map((id) => ({ id }))
      setDraft((current) =>
        current
          ? {
              ...current,
              models: mergeDiscoveredModels(current.models, entries, (model, entry) => ({
                ...entry,
                ...model,
                api: model.api ?? entry.api,
                baseUrl: model.baseUrl ?? entry.baseUrl,
                reasoning: model.reasoning === true || entry.reasoning === true || undefined,
                thinkingLevelMap: model.thinkingLevelMap ?? entry.thinkingLevelMap,
                cost: model.cost ?? entry.cost
              }))
            }
          : current
      )
      setMsg({ kind: 'ok', text: found.message })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setFetching(false)
    }
  }

  const detectLocal = async (): Promise<void> => {
    setDetecting(true)
    setMsg(null)
    try {
      const found = await window.yan.detectLocalModels()
      if (alive.current) setLocals(found)
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setDetecting(false)
    }
  }

  const fillFromLocal = async (server: LocalModelServer): Promise<void> => {
    const next: CustomProviderInput = {
      id: server.suggestedId ?? 'yan-local',
      api: 'openai-completions',
      baseUrl: server.baseUrl,
      models: []
    }
    setFetching(true)
    setMsg(null)
    try {
      const found = await window.yan.discoverCustomModels(next)
      if (!found.ok) throw new Error(found.message)
      const entries: CustomProviderModel[] = found.entries ?? found.models.map((id) => ({ id }))
      beginDraft({ ...next, models: entries.length ? entries : [{ id: '' }] })
    } catch (error) {
      setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setFetching(false)
    }
  }

  const runTest = async (item: CustomProviderView, mode: 'endpoint' | 'billable'): Promise<void> => {
    setTesting(`${item.id}:${mode}`)
    setTestResult(null)
    try {
      const result = await window.yan.testCustomProvider(item.id, mode, item.models[0]?.id ?? '')
      if (alive.current) setTestResult({ id: item.id, result })
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: errorText(error) })
    } finally {
      if (alive.current) setTesting('')
    }
  }

  return (
    <SettingsGroup
      title={t('customApi.title')}
      description={t('customApi.desc')}
      settingId="models-custom"
      testId="ms-custom"
      className="ms-custom"
      plain
    >

      {list === null ? <p className="ms-note">{t('customApi.loading')}</p> : null}

      {list?.length ? (
        <div className="settings-rows ms-rows">
          {list.map((item) => (
            <div className="ms-custom-row" key={item.id} data-testid={`ms-custom-row-${item.id}`}>
              <div className="ms-custom-main">
                <div className="ms-custom-name">
                  {item.id}
                  <Badge tone="neutral">{apiLabel(item.api)}</Badge>
                </div>
                <div className="ms-custom-meta">
                  <span>{item.baseUrl}</span>
                  <span>{t('customApi.modelCount', { n: item.models.length })}</span>
                  <span className={item.hasApiKey ? 'ms-ok' : 'ms-warn'}>
                    {item.hasApiKey ? t('customApi.keySet') : t('customApi.keyMissing')}
                  </span>
                </div>
              </div>
              <div className="ms-custom-actions">
                <Button
                  variant="secondary"
                  data-testid={`ms-custom-edit-${item.id}`}
                  isDisabled={busy}
                  onPress={() =>
                    beginDraft({
                      id: item.id,
                      api: item.api || 'openai-completions',
                      baseUrl: item.baseUrl,
                      models: item.models.length ? item.models : [{ id: '' }]
                    })
                  }
                >
                  {t('customApi.edit')}
                </Button>
                <Button
                  variant="secondary"
                  aria-expanded={testId === item.id}
                  data-testid={`ms-custom-test-${item.id}`}
                  onPress={() => {
                    setTestResult(null)
                    setTestId(testId === item.id ? null : item.id)
                  }}
                >
                  {t('customApi.test')}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={busy}
                  data-testid={`ms-custom-remove-${item.id}`}
                  icon={<Trash2 size={13} aria-hidden />}
                  onPress={() => setPendingRemove(item)}
                >
                  {t('customApi.remove')}
                </Button>
              </div>

              <SettingsReveal open={testId === item.id}>
                <div className="ms-custom-test" data-testid={`ms-custom-test-panel-${item.id}`}>
                  <div className="ms-custom-actions">
                    <Button
                      isDisabled={!!testing}
                      data-testid={`ms-custom-test-endpoint-${item.id}`}
                      onPress={() => void runTest(item, 'endpoint')}
                    >
                      {testing === `${item.id}:endpoint` ? t('customApi.testRunning') : t('customApi.testEndpoint')}
                    </Button>
                    <Button
                      isDisabled={!!testing}
                      data-testid={`ms-custom-test-billable-${item.id}`}
                      onPress={() => void runTest(item, 'billable')}
                    >
                      {testing === `${item.id}:billable` ? t('customApi.testRunning') : t('customApi.testBillable')}
                    </Button>
                  </div>
                  <p className="ms-note">{t('customApi.testCost')}</p>
                  {testResult?.id === item.id ? (
                    <p
                      className={testResult.result.ok ? 'ms-note ms-ok' : 'ms-note ms-warn'}
                      data-testid={`ms-custom-test-result-${item.id}`}
                    >
                      {testResult.result.message} · {testResult.result.ms}ms
                      {testResult.result.text ? ` · ${testResult.result.text.slice(0, 60)}` : ''}
                    </p>
                  ) : null}
                </div>
              </SettingsReveal>
            </div>
          ))}
        </div>
      ) : null}

      {draft ? (
        <div className="ms-custom-form" data-testid="ms-custom-form">
          <TextField
            label={t('customApi.id')}
            value={draft.id}
            isDisabled={busy}
            onChange={(value) => setDraft({ ...draft, id: value })}
            inputClassName="ms-custom-input"
          />
          <Select
            label={t('customApi.protocol')}
            selectedKey={draft.api}
            isDisabled={busy}
            onSelectionChange={(key) => setDraft({ ...draft, api: String(key) })}
          >
            {CUSTOM_API_CHOICES.map((choice) => (
              <ListBoxItem key={choice.id} id={choice.id}>
                {choice.label}
              </ListBoxItem>
            ))}
          </Select>
          <TextField
            label={t('customApi.baseUrl')}
            placeholder="https://api.example.com/v1"
            value={draft.baseUrl}
            isDisabled={busy}
            onChange={(value) => setDraft({ ...draft, baseUrl: value })}
            inputClassName="ms-custom-input"
          />
          <TextField
            label={t('customApi.apiKey')}
            type="password"
            autoComplete="off"
            placeholder={t('customApi.apiKeyPlaceholder')}
            value={draft.apiKey ?? ''}
            isDisabled={busy}
            onChange={(value) => setDraft({ ...draft, apiKey: value })}
            inputClassName="ms-custom-input"
          />

          <p className="ms-note">{t('customApi.modelsHint')}</p>
          {draft.models.map((model, index) => (
            <div className="ms-custom-model" key={index}>
              <TextField
                aria-label={t('customApi.modelId')}
                placeholder={t('customApi.modelId')}
                value={model.id}
                isDisabled={busy}
                onChange={(value) => patchModel(index, { id: value })}
                inputClassName="ms-custom-input"
              />
              <TextField
                aria-label={t('customApi.modelName')}
                placeholder={t('customApi.modelName')}
                value={model.name ?? ''}
                isDisabled={busy}
                onChange={(value) => patchModel(index, { name: value })}
                inputClassName="ms-custom-input"
              />
              <TextField
                aria-label={t('customApi.contextWindow')}
                placeholder={t('customApi.contextWindow')}
                type="number"
                value={model.contextWindow ? String(model.contextWindow) : ''}
                isDisabled={busy}
                onChange={(value) => patchModel(index, { contextWindow: Number(value) || undefined })}
                inputClassName="ms-custom-input"
              />
              <Checkbox
                isSelected={model.reasoning === true}
                isDisabled={busy}
                onChange={(value) => patchModel(index, { reasoning: value })}
              >
                {t('customApi.reasoning')}
              </Checkbox>
            </div>
          ))}

          <div className="ms-custom-actions">
            <Button
              variant="secondary"
              isDisabled={busy}
              icon={<Plus size={13} aria-hidden />}
              onPress={() =>
                setDraft({ ...draft, models: [...draft.models, { id: '' }] })
              }
            >
              {t('customApi.addModel')}
            </Button>
            <Button
              variant="secondary"
              isDisabled={fetching || busy}
              icon={<RefreshCw size={13} aria-hidden />}
              data-testid="ms-custom-fetch-models"
              onPress={() => void fetchModels()}
            >
              {fetching ? t('customApi.fetching') : t('customApi.fetchModels')}
            </Button>
            <span className="ms-custom-spacer" />
            <Button variant="secondary" isDisabled={busy} onPress={cancelDraft}>
              {t('customApi.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={busy}
              data-testid="ms-custom-save"
              onPress={() => void save()}
            >
              {t('customApi.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ms-custom-actions">
          <Button
            variant="secondary"
            icon={<Plus size={13} aria-hidden />}
            data-testid="ms-custom-add"
            onPress={() => beginDraft(blank())}
          >
            {t('customApi.add')}
          </Button>
          <Button
            variant="secondary"
            isDisabled={detecting}
            data-testid="ms-custom-detect"
            data-setting-id="models-custom-detect"
            onPress={() => void detectLocal()}
          >
            {detecting ? t('customApi.detecting') : t('customApi.detectLocal')}
          </Button>
        </div>
      )}

      {!draft && locals ? (
        <div
          className={locals.length ? 'ms-custom-locals settings-rows ms-rows' : 'ms-custom-locals'}
          data-testid="ms-custom-locals"
        >
          {locals.length ? (
            locals.map((server) => (
              <div className="ms-custom-row" key={`${server.kind}:${server.baseUrl}`}>
                <div className="ms-custom-main">
                  <div className="ms-custom-name">
                    {server.name}
                    {server.purpose === 'image' ? <Badge tone="neutral">{t('customApi.localImage')}</Badge> : null}
                  </div>
                  <div className="ms-custom-meta">
                    <span>{server.running ? server.baseUrl : server.installDir ?? server.baseUrl}</span>
                    {server.running || server.models.length ? (
                      <span>
                        {server.kind === 'comfyui'
                          ? t('customApi.localWorkflows', { n: server.models.length })
                          : t('customApi.localModels', { n: server.models.length })}
                      </span>
                    ) : null}
                    {!server.running ? <span className="ms-warn">{t('customApi.localStopped')}</span> : null}
                  </div>
                </div>
                {server.purpose === 'chat' && server.running ? (
                  <Button
                    isDisabled={fetching || busy}
                    data-testid={`ms-custom-local-use-${server.kind}`}
                    onPress={() => void fillFromLocal(server)}
                  >
                    {t('customApi.localUse')}
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="ms-note" data-testid="ms-custom-local-none">
              {t('customApi.localNone')}
            </p>
          )}
        </div>
      ) : null}

      {msg ? (
        <Notice tone={msg.kind} className="ms-msg" data-testid="ms-custom-msg">
          {msg.text}
        </Notice>
      ) : null}

      {pendingRemove ? (
        <ModalOverlay
          className="ms-overlay"
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setPendingRemove(null)
          }}
        >
          <Modal className="ms-modal">
            <Dialog title={t('customApi.remove')} closeLabel={t('ui.cancel')}>
              <p className="ms-confirm-body">{t('customApi.removeConfirm')}</p>
              <p className="ms-confirm-target">{pendingRemove.id}</p>
              <div className="ms-confirm-actions">
                <Button variant="secondary" onPress={() => setPendingRemove(null)}>
                  {t('ui.cancel')}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={busy}
                  data-testid="ms-custom-remove-confirm"
                  onPress={() => void remove(pendingRemove)}
                >
                  {t('customApi.remove')}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}

      {pendingShrink ? (
        <ModalOverlay
          className="ms-overlay"
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setPendingShrink(null)
          }}
        >
          <Modal className="ms-modal">
            <Dialog title={t('customApi.shrinkTitle')} closeLabel={t('ui.cancel')}>
              {pendingShrink.map((item) => (
                <p key={item.provider} className="ms-confirm-body">
                  {t('customApi.shrinkConfirm', { provider: item.provider, before: item.before, after: item.after })}
                </p>
              ))}
              <div className="ms-confirm-actions">
                <Button variant="secondary" onPress={() => setPendingShrink(null)}>
                  {t('ui.cancel')}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={busy}
                  data-testid="ms-custom-shrink-confirm"
                  onPress={() => void save(true)}
                >
                  {t('customApi.shrinkSave')}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </SettingsGroup>
  )
}
