import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { refreshModelsAfterRestart } from '../../state/refresh-models'
import type { CustomProviderInput, CustomProviderTestResult, CustomProviderView } from '../../../../shared/ipc'
import { CUSTOM_API_CHOICES } from '../../../../shared/custom-provider'
import { Icon } from '../../icons/Icon'
import { Button } from '../ui'

/**
 * 「接入」设置页的自定义 API 服务（实施-23 M2）。
 *
 * 真源是 pi 的 `models.json`：宿主负责读写与校验（`main/custom-providers.ts`），
 * 这里只做表单。两条硬边界：
 *   · 密钥**只去不回** —— 列表里只显示「已设置 / 未设置」，输入框不回显已存的值；
 *   · 协议是**受支持集合的下拉**，不是自由输入（M0 实测：pi 不校验 api 字段，
 *     填错了会在真正请求时才炸，界面必须替用户挡住）。
 */
export function CustomProviderForm() {
  const t = useT()
  const [list, setList] = useState<CustomProviderView[] | null>(null)
  const [draft, setDraft] = useState<CustomProviderInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /* 连接测试：面板一次只开一个，结果也只留最近一次（避免和上一条对不上号） */
  const [testId, setTestId] = useState<string | null>(null)
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState<CustomProviderTestResult | null>(null)

  const runTest = async (id: string, mode: 'endpoint' | 'billable', modelId: string): Promise<void> => {
    setTesting(`${id}:${mode}`)
    setTestResult(null)
    try {
      setTestResult(await window.yan.testCustomProvider(id, mode, modelId))
    } finally {
      setTesting('')
    }
  }

  const reload = useCallback(async () => {
    const next = await window.yan.customProviders()
    setList(next)
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

  const [fetching, setFetching] = useState(false)

  /** 从端点拉模型填进表单（保留已填的行，只追加没有的 ID） */
  const fetchModels = async (): Promise<void> => {
    if (!draft) return
    setFetching(true)
    setMsg(null)
    try {
      const found = await window.yan.discoverCustomModels(draft)
      if (!found.ok) {
        setMsg({ kind: 'err', text: found.message })
        return
      }
      const entries: CustomProviderInput['models'] = found.entries ?? found.models.map((id) => ({ id }))
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      /* 已有的行保留用户填的名称与上下文，补上端点和 pi 目录给出的协议与思考能力 */
      const kept = draft.models
        .filter((model) => model.id.trim())
        .map((model) => {
          const entry = byId.get(model.id.trim())
          if (!entry) return model
          return {
            ...entry,
            ...model,
            api: model.api ?? entry.api,
            baseUrl: model.baseUrl ?? entry.baseUrl,
            reasoning: model.reasoning === true || entry.reasoning === true || undefined,
            thinkingLevelMap: model.thinkingLevelMap ?? entry.thinkingLevelMap,
            cost: model.cost ?? entry.cost
          }
        })
      const known = new Set(kept.map((model) => model.id.trim()))
      const added = entries.filter((entry) => !known.has(entry.id))
      setDraft({ ...draft, models: [...kept, ...added] })
      setMsg({ kind: 'ok', text: found.message })
    } finally {
      setFetching(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.yan.saveCustomProvider({
        ...draft,
        /* 空白表示沿用旧值；空白字段不要覆盖磁盘上的 key */
        ...(draft.apiKey && draft.apiKey.trim() ? {} : { apiKey: undefined })
      })
      if (!result.ok) {
        setMsg({ kind: 'err', text: (result.errors ?? []).join('；') })
        return
      }
      setList(result.providers ?? [])
      setDraft(null)
      setMsg({ kind: 'ok', text: t('customApi.saved') })
      refreshModelsAfterRestart()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.yan.removeCustomProvider(id)
      if (!result.ok) {
        setMsg({ kind: 'err', text: (result.errors ?? []).join('；') })
        return
      }
      setList(result.providers ?? [])
      setMsg({ kind: 'ok', text: t('customApi.removed') })
      refreshModelsAfterRestart()
    } finally {
      setBusy(false)
    }
  }

  const patchModel = (index: number, patch: Partial<CustomProviderInput['models'][number]>): void => {
    if (!draft) return
    const models = draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model))
    setDraft({ ...draft, models })
  }

  return (
    <div className="ui-rows" data-testid="custom-api">
      <div className="ui-row-desc custom-api-desc">{t('customApi.desc')}</div>

      {list === null ? <div className="ui-row-desc">{t('customApi.loading')}</div> : null}

      {list?.map((item) => (
        <div className="ui-row custom-api-row" key={item.id} data-testid={`custom-api-row-${item.id}`}>
          <div className="custom-api-row-main">
            <span className="ui-row-name">{item.id}</span>
            <span className="ui-row-desc">
              {item.api} · {item.baseUrl} · {t('customApi.modelCount', { n: item.models.length })} ·{' '}
              {item.hasApiKey ? t('customApi.keySet') : t('customApi.keyMissing')}
            </span>
          </div>
          <span className="spacer" />
          <Button type="button" data-testid={`custom-api-edit-${item.id}`} onClick={() =>
              setDraft({
                id: item.id,
                api: item.api || 'openai-completions',
                baseUrl: item.baseUrl,
                models: item.models.length ? item.models : [{ id: '' }]
              })
            }>
            {t('customApi.edit')}
          </Button>
          <Button type="button" data-testid={`custom-api-test-${item.id}`} aria-expanded={testId === item.id} onClick={() => {
              setTestResult(null)
              setTestId(testId === item.id ? null : item.id)
            }}>
            {t('customApi.test')}
          </Button>
          <Button variant="danger" type="button" data-testid={`custom-api-remove-${item.id}`} disabled={busy} onClick={() => void remove(item.id)}>
            {t('customApi.remove')}
          </Button>
        </div>
      ))}

      {draft ? (
        <div className="custom-api-form" data-testid="custom-api-form">
          <label className="ui-row">
            <span className="ui-row-name">{t('customApi.id')}</span>
            <input
              className="ui-input"
              value={draft.id}
              data-testid="custom-api-id"
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </label>
          <label className="ui-row">
            <span className="ui-row-name">{t('customApi.protocol')}</span>
            <select
              className="ui-input"
              value={draft.api}
              data-testid="custom-api-protocol"
              onChange={(event) => setDraft({ ...draft, api: event.target.value })}
            >
              {CUSTOM_API_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ui-row">
            <span className="ui-row-name">{t('customApi.baseUrl')}</span>
            <input
              className="ui-input"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              data-testid="custom-api-base-url"
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label className="ui-row">
            <span className="ui-row-name">{t('customApi.apiKey')}</span>
            <input
              className="ui-input"
              type="password"
              /* 不回显已存密钥：留空表示沿用 */
              value={draft.apiKey ?? ''}
              placeholder={t('customApi.apiKeyPlaceholder')}
              data-testid="custom-api-key"
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>

          <div className="ui-row-desc">{t('customApi.modelsHint')}</div>
          {draft.models.map((model, index) => (
            <div className="ui-row custom-api-model" key={index}>
              <input
                className="ui-input"
                value={model.id}
                placeholder={t('customApi.modelId')}
                data-testid={`custom-api-model-id-${index}`}
                onChange={(event) => patchModel(index, { id: event.target.value })}
              />
              <input
                className="ui-input"
                value={model.name ?? ''}
                placeholder={t('customApi.modelName')}
                data-testid={`custom-api-model-name-${index}`}
                onChange={(event) => patchModel(index, { name: event.target.value })}
              />
              <input
                className="ui-input num"
                type="number"
                value={model.contextWindow ?? ''}
                placeholder={t('customApi.contextWindow')}
                data-testid={`custom-api-model-context-${index}`}
                onChange={(event) =>
                  patchModel(index, { contextWindow: Number(event.target.value) || undefined })
                }
              />
              <label className="custom-api-check">
                <input
                  type="checkbox"
                  checked={model.reasoning === true}
                  data-testid={`custom-api-model-reasoning-${index}`}
                  onChange={(event) => patchModel(index, { reasoning: event.target.checked })}
                />
                <span>{t('customApi.reasoning')}</span>
              </label>
              {model.api && model.api !== draft.api ? (
                <span className="ui-badge" title={t('customApi.modelApiHint', { url: model.baseUrl ?? draft.baseUrl })} data-testid={`custom-api-model-api-${index}`}>
                  {CUSTOM_API_CHOICES.find((choice) => choice.id === model.api)?.label ?? model.api}
                </span>
              ) : null}
            </div>
          ))}

          <div className="ui-row">
            <Button icon="plus" type="button" data-testid="custom-api-add-model" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: '' }] })}>{t('customApi.addModel')}
            </Button>
            <Button type="button" disabled={fetching || busy} data-testid="custom-api-fetch-models" onClick={() => void fetchModels()}>
              {fetching ? t('customApi.fetching') : t('customApi.fetchModels')}
            </Button>
            <span className="spacer" />
            <Button type="button" onClick={() => setDraft(null)}>
              {t('customApi.cancel')}
            </Button>
            <Button variant="primary" type="button" disabled={busy} data-testid="custom-api-save" onClick={() => void save()}>
              {t('customApi.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ui-row custom-api-add-row">
          <Button icon="plus" type="button" data-testid="custom-api-add" onClick={() => setDraft(blank())}>{t('customApi.add')}
          </Button>
        </div>
      )}

      {testId
        ? (() => {
            const item = list?.find((entry) => entry.id === testId)
            if (!item) return null
            const modelId = item.models[0]?.id ?? ''
            return (
              <div className="custom-api-test" data-testid={`custom-api-test-panel-${item.id}`}>
                <div className="ui-row custom-api-test-actions">
                  <Button type="button" disabled={!!testing} data-testid={`custom-api-test-endpoint-${item.id}`} onClick={() => void runTest(item.id, 'endpoint', modelId)}>
                    {testing === `${item.id}:endpoint` ? t('customApi.testRunning') : t('customApi.testEndpoint')}
                  </Button>
                  <Button type="button" disabled={!!testing} data-testid={`custom-api-test-billable-${item.id}`} onClick={() => void runTest(item.id, 'billable', modelId)}>
                    {testing === `${item.id}:billable` ? t('customApi.testRunning') : t('customApi.testBillable')}
                  </Button>
                  <span className="spacer" />
                </div>
                {/* 成本提示必须就在按钮旁边：点下去之前就要知道哪一段会花钱 */}
                <div className="ui-row-desc">{t('customApi.testCost')}</div>
                {testResult ? (
                  <div
                    className={testResult.ok ? 'ui-row-desc' : 'ui-row-desc err'}
                    data-testid={`custom-api-test-result-${item.id}`}
                  >
                    <Icon name={testResult.ok ? 'check' : 'alert-circle'} size={12} />{' '}
                    {testResult.message +
                      ` · ${testResult.ms}ms` +
                      (testResult.text ? ` · ${testResult.text.slice(0, 60)}` : '')}
                  </div>
                ) : null}
              </div>
            )
          })()
        : null}

      {msg ? (
        <div className={msg.kind === 'err' ? 'ui-row-desc err' : 'ui-row-desc'} data-testid="custom-api-msg">
          {msg.text}
        </div>
      ) : null}
    </div>
  )
}
