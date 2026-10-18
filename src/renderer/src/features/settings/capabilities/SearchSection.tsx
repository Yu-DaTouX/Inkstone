import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import {
  SEARCH_PROVIDERS,
  type SearchApiConfigView,
  type SearchBackendStatus,
  type SearchProvider,
  type SearchProviderState
} from '../../../../../shared/search'
import { Badge, Button, TextField } from '../../../ui'
import { Actions, Group, Item, ItemHead, Meta, Panel, Warn } from './parts'

const OPENCLI_RELEASES = 'https://www.npmjs.com/package/@jackwener/opencli?activeTab=versions'
const OPENCLI_EXTENSION = 'https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk'
const NODE_DOWNLOAD = 'https://nodejs.org/zh-cn/download'

type InstallState = { busy: boolean; ok?: boolean; needsNode?: boolean; text?: string }

export function SearchBackendSection(): ReactElement {
  const t = useT()
  return (
    <Panel label={t('set.searchTools')}>
      <SearchBackendGroup />
    </Panel>
  )
}

export function SearchApiSection(): ReactElement {
  const t = useT()
  return (
    <Panel label={t('search.apiTitle')}>
      <SearchApiGroup />
    </Panel>
  )
}

function SearchBackendGroup(): ReactElement {
  const t = useT()
  const [backend, setBackend] = useState<SearchBackendStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [probeFailed, setProbeFailed] = useState(false)
  const [install, setInstall] = useState<InstallState | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const next = await window.yan.search.doctor()
      if (!alive.current) return
      setBackend(next)
      setProbeFailed(false)
    } catch {
      if (!alive.current) return
      setBackend(null)
      setProbeFailed(true)
    } finally {
      if (alive.current) setChecking(false)
    }
  }, [])
  useEffect(() => {
    void check()
  }, [check])

  const runInstall = async (): Promise<void> => {
    setInstall({ busy: true })
    try {
      const r = await window.yan.search.installBackend()
      if (!alive.current) return
      setInstall({ busy: false, ok: r.ok, needsNode: r.needsNode, text: r.ok ? t('set.opencliInstalled') : [r.error, r.log].filter(Boolean).join('\n') })
      if (r.ok) await check()
    } catch (cause) {
      if (alive.current) setInstall({ busy: false, ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const status =
    backend === null
      ? probeFailed
        ? t('set.searchBackendProbeFailed')
        : t('set.searchBackendUnknown')
      : backend.available
        ? backend.code === 'extension_not_connected'
          ? t('set.searchBackendExtOff', { version: backend.version ?? '?' })
          : t('set.searchBackendReady', { version: backend.version ?? '?' })
        : backend.code === 'backend_unusable'
          ? t('set.searchBackendUnusable', { version: backend.version ?? '?' })
          : t('set.searchBackendMissing')
  const hint =
    backend && !backend.available
      ? backend.code === 'backend_unusable'
        ? t('set.searchBackendUnusableHint')
        : /\bnode\b/i.test(backend.detail ?? '')
          ? t('set.searchBackendNodeHint')
          : t('set.searchBackendHint')
      : backend?.code === 'extension_not_connected'
        ? t('set.searchBackendExtHint')
        : ''
  const detail = backend && !backend.available && backend.detail ? backend.detail : ''
  const needsNode = !!install?.needsNode || (!!backend && !backend.available && /\bnode\b/i.test(backend.detail ?? ''))

  return (
    <div data-testid="cap-search-backend" data-setting-id="caps-tools-opencli">
      <Group
        title={t('set.searchBackend')}
        desc={t('set.extToolsDesc')}
        card
        actions={
          <Button size="sm" variant="secondary" isDisabled={checking || !!install?.busy} onPress={() => void check()} data-testid="cap-search-recheck">
            {checking ? t('set.searchBackendChecking') : t('set.extRecheck')}
          </Button>
        }
      >
        <Meta>{status}</Meta>
        {hint ? <Meta>{hint}</Meta> : null}
        {detail ? <Meta title={detail}>{detail.length > 240 ? `${detail.slice(0, 240)}…` : detail}</Meta> : null}
        {install?.text ? install.ok ? <Meta>{install.text}</Meta> : <Warn>{install.text}</Warn> : null}
        <Actions>
          {backend ? (
            <Button size="sm" variant="primary" isDisabled={!!install?.busy || checking} onPress={() => void runInstall()} data-testid="cap-search-install">
              {install?.busy ? t('set.opencliInstalling') : backend.available ? t('set.opencliUpdate') : t('set.opencliInstall')}
            </Button>
          ) : null}
          {needsNode ? (
            <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(NODE_DOWNLOAD)}>
              {t('set.opencliGetNode')}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(OPENCLI_EXTENSION)}>
            {t('set.opencliExtStore')}
          </Button>
          <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(OPENCLI_RELEASES)}>
            {t('set.releasePage')}
          </Button>
        </Actions>
      </Group>
    </div>
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
              size="sm"
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
          <Item testId="cap-search-api-deepseek">
            <ItemHead>
              <span className="caps-name">{t('search.deepseekTitle')}</span>
            </ItemHead>
            <Meta>{t('search.role.deepseek')}</Meta>
            <Meta>
              <span data-testid="cap-search-api-status-deepseek">
                {config?.deepseekModelKey ? t('search.deepseekReady') : t('search.deepseekMissing')}
              </span>
            </Meta>
          </Item>
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
    <Item testId={`cap-search-api-${provider.id}`}>
      <ItemHead>
        <span className="caps-name">{provider.label}</span>
        {provider.keyOptional ? <Badge>{t('search.apiOptional')}</Badge> : null}
      </ItemHead>
      <Meta>{t(`search.role.${provider.id}` as MessageKey)}</Meta>
      <Meta>
        <span data-testid={`cap-search-api-status-${provider.id}`}>
          {state?.configured
            ? state.source === 'env'
              ? t('search.apiReadyEnv', { env: provider.envName })
              : t('search.apiReady')
            : t('search.apiMissing')}
        </span>
      </Meta>
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
          <Button size="sm" variant="primary" type="submit" isDisabled={busy || !key.trim()}>
            {t('search.apiSave')}
          </Button>
          {state?.configured ? (
            <Button size="sm" variant="danger" onPress={() => void clear()}>
              {t('search.apiClear')}
            </Button>
          ) : null}
        </form>
      ) : null}
      {error ? <Warn>{error}</Warn> : null}
      <Actions>
        <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(provider.keyUrl)}>
          {t('search.apiGet')}
        </Button>
      </Actions>
    </Item>
  )
}
