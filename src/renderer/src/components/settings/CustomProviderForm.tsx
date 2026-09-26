import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import type { CustomProviderInput, CustomProviderTestResult, CustomProviderView } from '../../../../shared/ipc'
import { CUSTOM_API_CHOICES } from '../../../../shared/custom-provider'

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
    <div className="set-group" data-testid="custom-api">
      <div className="set-label">
        <div className="set-name">{t('customApi.title')}</div>
        <div className="set-desc">{t('customApi.desc')}</div>
      </div>

      {list === null ? <div className="set-desc">{t('customApi.loading')}</div> : null}

      {list?.map((item) => (
        <div className="set-row custom-api-row" key={item.id} data-testid={`custom-api-row-${item.id}`}>
          <div className="custom-api-row-main">
            <span className="set-name">{item.id}</span>
            <span className="set-desc">
              {item.api} · {item.baseUrl} · {t('customApi.modelCount', { n: item.models.length })} ·{' '}
              {item.hasApiKey ? t('customApi.keySet') : t('customApi.keyMissing')}
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="set-btn"
            data-testid={`custom-api-edit-${item.id}`}
            onClick={() =>
              setDraft({
                id: item.id,
                api: item.api || 'openai-completions',
                baseUrl: item.baseUrl,
                models: item.models.length ? item.models : [{ id: '' }]
              })
            }
          >
            {t('customApi.edit')}
          </button>
          <button
            type="button"
            className="set-btn"
            data-testid={`custom-api-test-${item.id}`}
            aria-expanded={testId === item.id}
            onClick={() => {
              setTestResult(null)
              setTestId(testId === item.id ? null : item.id)
            }}
          >
            {t('customApi.test')}
          </button>
          <button
            type="button"
            className="set-btn danger"
            data-testid={`custom-api-remove-${item.id}`}
            disabled={busy}
            onClick={() => void remove(item.id)}
          >
            {t('customApi.remove')}
          </button>
        </div>
      ))}

      {draft ? (
        <div className="custom-api-form" data-testid="custom-api-form">
          <label className="set-row">
            <span className="set-name">{t('customApi.id')}</span>
            <input
              className="set-input"
              value={draft.id}
              data-testid="custom-api-id"
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </label>
          <label className="set-row">
            <span className="set-name">{t('customApi.protocol')}</span>
            <select
              className="set-input"
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
          <label className="set-row">
            <span className="set-name">{t('customApi.baseUrl')}</span>
            <input
              className="set-input"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              data-testid="custom-api-base-url"
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label className="set-row">
            <span className="set-name">{t('customApi.apiKey')}</span>
            <input
              className="set-input"
              type="password"
              /* 不回显已存密钥：留空表示沿用 */
              value={draft.apiKey ?? ''}
              placeholder={t('customApi.apiKeyPlaceholder')}
              data-testid="custom-api-key"
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>

          {draft.models.map((model, index) => (
            <div className="set-row custom-api-model" key={index}>
              <input
                className="set-input"
                value={model.id}
                placeholder={t('customApi.modelId')}
                data-testid={`custom-api-model-id-${index}`}
                onChange={(event) => patchModel(index, { id: event.target.value })}
              />
              <input
                className="set-input"
                value={model.name ?? ''}
                placeholder={t('customApi.modelName')}
                data-testid={`custom-api-model-name-${index}`}
                onChange={(event) => patchModel(index, { name: event.target.value })}
              />
              <input
                className="set-input"
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
            </div>
          ))}

          <div className="set-row">
            <button
              type="button"
              className="set-btn"
              data-testid="custom-api-add-model"
              onClick={() => setDraft({ ...draft, models: [...draft.models, { id: '' }] })}
            >
              <Icon name="plus" size={12} /> {t('customApi.addModel')}
            </button>
            <span className="spacer" />
            <button type="button" className="set-btn" onClick={() => setDraft(null)}>
              {t('customApi.cancel')}
            </button>
            <button
              type="button"
              className="set-btn primary"
              disabled={busy}
              data-testid="custom-api-save"
              onClick={() => void save()}
            >
              {t('customApi.save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="set-row custom-api-add-row">
          <button
            type="button"
            className="set-btn"
            data-testid="custom-api-add"
            onClick={() => setDraft(blank())}
          >
            <Icon name="plus" size={12} /> {t('customApi.add')}
          </button>
        </div>
      )}

      {testId
        ? (() => {
            const item = list?.find((entry) => entry.id === testId)
            if (!item) return null
            const modelId = item.models[0]?.id ?? ''
            return (
              <div className="custom-api-test" data-testid={`custom-api-test-panel-${item.id}`}>
                <div className="set-desc">{t('customApi.testHint')}</div>
                <div className="set-row custom-api-test-actions">
                  <button
                    type="button"
                    className="set-btn"
                    disabled={!!testing}
                    data-testid={`custom-api-test-endpoint-${item.id}`}
                    onClick={() => void runTest(item.id, 'endpoint', modelId)}
                  >
                    {testing === `${item.id}:endpoint` ? t('customApi.testRunning') : t('customApi.testEndpoint')}
                  </button>
                  <button
                    type="button"
                    className="set-btn"
                    disabled={!!testing}
                    data-testid={`custom-api-test-billable-${item.id}`}
                    onClick={() => void runTest(item.id, 'billable', modelId)}
                  >
                    {testing === `${item.id}:billable` ? t('customApi.testRunning') : t('customApi.testBillable')}
                  </button>
                  <span className="spacer" />
                </div>
                {/* 成本提示必须就在按钮旁边：点下去之前就要知道哪一段会花钱 */}
                <div className="set-desc">{t('customApi.testCost')}</div>
                {testResult ? (
                  <div
                    className={testResult.ok ? 'set-desc' : 'set-desc err'}
                    data-testid={`custom-api-test-result-${item.id}`}
                  >
                    {(testResult.ok ? '✓ ' : '✗ ') +
                      testResult.message +
                      ` · ${testResult.ms}ms` +
                      (testResult.text ? ` · ${testResult.text.slice(0, 60)}` : '')}
                  </div>
                ) : null}
              </div>
            )
          })()
        : null}

      {msg ? (
        <div className={msg.kind === 'err' ? 'set-desc err' : 'set-desc'} data-testid="custom-api-msg">
          {msg.text}
        </div>
      ) : null}
    </div>
  )
}
