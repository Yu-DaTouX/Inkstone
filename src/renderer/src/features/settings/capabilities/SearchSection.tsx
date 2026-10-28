import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import {
  SEARCH_PROVIDERS,
  type SearchApiConfigView,
  type SearchProvider,
  type SearchProviderState
} from '../../../../../shared/search'
import { Button, TextField } from '../../../ui'
import { Entry, Group, Panel, Warn } from './parts'

export function SearchApiSection(): ReactElement {
  const t = useT()
  return (
    <Panel label={t('search.apiTitle')}>
      <SearchApiGroup />
    </Panel>
  )
}

function SearchApiGroup(): ReactElement {
  const t = useT()
  const [config, setConfig] = useState<SearchApiConfigView | null>(null)
  const load = useCallback(async (): Promise<void> => {
    try {
      setConfig(await window.yan.search.apiConfig())
    } catch {
      setConfig(null)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div data-testid="cap-search-api" data-setting-id="caps-tools-search-keys">
      <Group
        title={t('search.apiTitle')}
        desc={t('search.apiDesc')}
        actions={
          config?.hintDismissed && !config.configured ? (
            <Button
              variant="secondary"
              data-testid="cap-search-api-rehint"
              onPress={() => void window.yan.search.setApiHintDismissed(false).then(load).catch(() => undefined)}
            >
              {t('search.apiHintReenable')}
            </Button>
          ) : undefined
        }
      >
        <div className="caps-list">
          <Entry
            testId="cap-search-api-deepseek"
            name={t('search.deepseekTitle')}
            meta={[
              <span key="status" data-testid="cap-search-api-status-deepseek">
                {config?.deepseekModelKey ? t('search.deepseekReady') : t('search.deepseekMissing')}
              </span>,
              t('search.role.deepseek')
            ]}
          />
          {SEARCH_PROVIDERS.map((provider) => (
            <SearchProviderItem key={provider.id} provider={provider} state={config?.providers[provider.id]} onChanged={load} />
          ))}
        </div>
      </Group>
    </div>
  )
}

function SearchProviderItem({
  provider,
  state,
  onChanged
}: {
  provider: SearchProvider
  state: SearchProviderState | undefined
  onChanged: () => Promise<void>
}): ReactElement {
  const t = useT()
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const placeholder = t('search.apiPlaceholder', { name: provider.label })

  const save = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (busy || !key.trim()) return
    setBusy(true)
    try {
      const res = await window.yan.search.setApiKey(provider.id, key)
      if (!res.ok) {
        setError(res.error ?? t('search.apiSaveFailed'))
        return
      }
      setError('')
      setKey('')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('search.apiSaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const clear = async (): Promise<void> => {
    await window.yan.search.clearApiKey(provider.id)
    await onChanged()
  }

  return (
    <Entry
      testId={`cap-search-api-${provider.id}`}
      name={provider.label}
      meta={[
        <span key="status" data-testid={`cap-search-api-status-${provider.id}`}>
          {state?.configured
            ? state.source === 'env'
              ? t('search.apiReadyEnv', { env: provider.envName })
              : t('search.apiReady')
            : t('search.apiMissing')}
        </span>,
        provider.keyOptional ? t('search.apiOptional') : null,
        t(`search.role.${provider.id}` as MessageKey)
      ]}
      actions={
        <>
          <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(provider.keyUrl)}>
            {t('search.apiGet')}
          </Button>
          {state?.source !== 'env' && state?.configured ? (
            <Button variant="danger" onPress={() => void clear()}>
              {t('search.apiClear')}
            </Button>
          ) : null}
        </>
      }
    >
      {state?.source !== 'env' ? (
        <form className="caps-field" onSubmit={(event) => void save(event)}>
          <TextField
            aria-label={placeholder}
            className="caps-field-input"
            type="password"
            autoComplete="off"
            maxLength={200}
            value={key}
            onChange={setKey}
            placeholder={placeholder}
            data-testid={`cap-search-api-key-${provider.id}`}
          />
          <Button variant="primary" type="submit" isDisabled={busy || !key.trim()}>
            {t('search.apiSave')}
          </Button>
        </form>
      ) : null}
      {error ? <Warn>{error}</Warn> : null}
    </Entry>
  )
}
