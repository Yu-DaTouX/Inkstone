import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type {
  BuiltinCapabilityView,
  CapabilitySearchResultView,
  CapabilitySettingsSnapshot,
  CapabilityVerificationStatus
} from '../../../../shared/ipc'

const STRATEGIES = ['existing-only', 'search-and-recommend', 'auto-connect'] as const

export function CapabilitiesTab(): React.JSX.Element {
  const t = useT()
  const tk = (key: string): string => t(key as MessageKey)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const strategy = settings?.capabilityStrategy ?? 'auto-connect'
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [builtin, setBuiltin] = useState<BuiltinCapabilityView[]>([])
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState<CapabilitySearchResultView | null>(null)
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState('')
  const [operations, setOperations] = useState<Record<string, CapabilityVerificationStatus>>({})
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const [next, builtins] = await Promise.all([
      window.yan.capabilities.snapshot(),
      window.yan.builtinCapabilities.list()
    ])
    if (mounted.current) {
      setSnapshot(next)
      setBuiltin(builtins)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : tk('cap.loadFailed')))
    return () => {
      mounted.current = false
    }
  }, [refresh])

  const runSearch = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (searching || searchText.trim().length < 2) return
    setSearching(true)
    setNotice('')
    try {
      setSearch(await window.yan.capabilities.discover(searchText))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tk('cap.searchFailed'))
      setSearch(null)
    } finally {
      setSearching(false)
    }
  }

  const verify = async (serverId: string): Promise<void> => {
    setNotice('')
    const started = await window.yan.capabilities.verify(serverId)
    if (!started.ok || !started.operationId) {
      setNotice(started.error ?? tk('cap.verifyFailed'))
      return
    }
    const operationId = started.operationId
    setOperations((old) => ({
      ...old,
      [serverId]: { operationId, state: 'connecting' }
    }))
    for (let attempt = 0; attempt < 70 && mounted.current; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const state = await window.yan.capabilities.verification(operationId)
      if (!state || state.state !== 'connecting') {
        if (!mounted.current) return
        if (state) setOperations((old) => ({ ...old, [serverId]: state }))
        await refresh().catch(() => undefined)
        return
      }
    }
    if (mounted.current) {
      setOperations((old) => ({ ...old, [serverId]: { operationId, state: 'error' } }))
    }
  }

  const cancelVerification = async (serverId: string, operationId: string): Promise<void> => {
    const result = await window.yan.capabilities.cancelVerification(operationId)
    if (!result.ok) setNotice(result.error ?? tk('cap.cancelFailed'))
    const state = await window.yan.capabilities.verification(operationId)
    if (state) setOperations((old) => ({ ...old, [serverId]: state }))
    await refresh().catch(() => undefined)
  }

  return (
    <div className="set-group" data-testid="set-capabilities">
      <div className="set-row set-row-col" data-testid="cap-strategy">
        <div className="set-label">
          <div className="set-name">{t('cap.strategyTitle')}</div>
          <div className="set-desc">{t('cap.strategyDesc')}</div>
        </div>
        <div className="seg" role="group" aria-label={t('cap.strategyTitle')}>
          {STRATEGIES.map((value) => (
            <button
              key={value}
              type="button"
              className={`seg-btn ${strategy === value ? 'sel' : ''}`}
              aria-pressed={strategy === value}
              data-testid={`cap-strategy-${value}`}
              onClick={() => void patchSettings({ capabilityStrategy: value })}
            >
              {t(`cap.strategy.${value}` as MessageKey)}
            </button>
          ))}
        </div>
        <div className="set-desc">{t(`cap.strategyDesc.${strategy}` as MessageKey)}</div>
      </div>

      <div className="set-row set-row-col" data-testid="cap-search">
        <div className="set-label">
          <div className="set-name">{t('cap.searchTitle')}</div>
          <div className="set-desc">{t('cap.searchDesc')}</div>
        </div>
        <form className="pkg-install-row" onSubmit={(event) => void runSearch(event)}>
          <input
            className="set-input"
            value={searchText}
            maxLength={500}
            placeholder={t('cap.searchPlaceholder')}
            aria-label={t('cap.searchPlaceholder')}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <button type="submit" className="env-mini" disabled={searching || searchText.trim().length < 2}>
            {searching ? t('cap.searching') : t('cap.search')}
          </button>
        </form>
        {search ? (
          <>
            <div className="pkg-list" data-testid="cap-search-sources">
              {search.sources.map((source) => (
                <div className="pkg-detail-line" key={source.sourceId}>
                  {source.sourceId === 'npm-registry' ? t('cap.source.npm') : t('cap.source.mcp')} ·{' '}
                  {source.ok ? t('cap.sourceOk') : t('cap.sourceFailed')} · {t('cap.sourceCounts', {
                    pages: source.pages,
                    count: source.candidateCount
                  })}
                </div>
              ))}
            </div>
            {search.reason ? <div className="pkg-detail-warn">{t(`cap.searchReason.${search.reason}` as MessageKey)}</div> : null}
            {search.candidates.length === 0 ? <div className="set-desc">{t('cap.noCandidates')}</div> : null}
            <div className="pkg-list" data-testid="cap-search-results">
              {search.candidates.map((candidate) => (
                <article className="pkg-item" key={candidate.candidateId} data-testid="cap-candidate">
                  <div className="pkg-item-main">
                    <span className="pkg-name">{candidate.title}</span>
                    {candidate.version ? <span className="pkg-ver">{candidate.version}</span> : null}
                    <span className={`pkg-scope ${candidate.verification === 'metadata-only' ? 'project' : 'user'}`}>
                      {t(`cap.verification.${candidate.verification}` as MessageKey)}
                    </span>
                    <span className="pkg-spacer" />
                    <span className="pkg-dim">{candidate.kind === 'skill' ? t('cap.skill') : t('cap.mcp')}</span>
                  </div>
                  <div className="pkg-detail-line">{candidate.summary}</div>
                  <div className="pkg-detail-line pkg-dim">
                    {candidate.publisher ? `${candidate.publisher} · ` : ''}{candidate.installKind}
                  </div>
                  <div className="pkg-detail-warn">{t('cap.candidateWarning')}</div>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="set-row set-row-col" data-testid="cap-builtins">
        <div className="set-label">
          <div className="set-name">{t('cap.builtinTitle')}</div>
          <div className="set-desc">{t('cap.builtinDesc')}</div>
        </div>
        <div className="pkg-list">
          {builtin.length === 0 ? <div className="set-desc">{t('cap.emptyBuiltin')}</div> : null}
          {builtin.map((item) => (
            <div className="pkg-item" key={item.id} data-testid="cap-builtin">
              <div className="pkg-item-main">
                <span className="pkg-name">{item.id}</span>
                {item.file ? <span className="pkg-ver">{item.file}</span> : null}
                <span className="pkg-scope user">{t('cap.builtinBadge')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="set-row set-row-col" data-testid="cap-skills">
        <div className="set-label">
          <div className="set-name">{t('cap.skillsTitle')}</div>
          <div className="set-desc">{t('cap.skillsDesc')}</div>
        </div>
        <div className="pkg-list">
          {!snapshot || snapshot.skills.length === 0 ? <div className="set-desc">{t('cap.emptySkills')}</div> : null}
          {snapshot?.skills.map((skill) => (
            <div className="pkg-item" key={skill.id} data-testid="cap-skill">
              <div className="pkg-item-main">
                <span className="pkg-name">{skill.title}</span>
                <span className="pkg-spacer" />
                <span className="pkg-scope user">{t('cap.ready')}</span>
              </div>
              {skill.description ? <div className="pkg-detail-line">{skill.description}</div> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="set-row set-row-col" data-testid="cap-mcp">
        <div className="set-label">
          <div className="set-name">{t('cap.mcpTitle')}</div>
          <div className="set-desc">{t('cap.mcpDesc')}</div>
        </div>
        {snapshot?.configWarning ? <div className="pkg-detail-warn">{t('cap.configWarning')}</div> : null}
        <div className="pkg-list">
          {!snapshot || snapshot.servers.length === 0 ? <div className="set-desc">{t('cap.emptyMcp')}</div> : null}
          {snapshot?.servers.map((server) => {
            const operation = operations[server.id]
            return (
              <article className="pkg-item" key={server.id} data-testid="cap-mcp-server">
                <div className="pkg-item-main">
                  <span className="pkg-name">{server.title}</span>
                  <span className="pkg-ver">{server.transport}</span>
                  <span className="pkg-scope user">{t(`cap.status.${server.status}` as MessageKey)}</span>
                  {server.projectScoped ? <span className="pkg-scope project">{t('cap.projectScoped')}</span> : null}
                  {!server.enabled ? <span className="pkg-scope project">{t('cap.disabled')}</span> : null}
                  <span className="pkg-spacer" />
                  {operation?.state === 'connecting' ? (
                    <button
                      type="button"
                      className="env-mini"
                      onClick={() => void cancelVerification(server.id, operation.operationId)}
                    >
                      {t('cap.cancel')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="env-mini"
                      disabled={!server.enabled}
                      onClick={() => void verify(server.id)}
                    >
                      {t('cap.verify')}
                    </button>
                  )}
                </div>
                <div className="pkg-detail-line pkg-dim">
                  {server.endpointOrigin ? `${server.endpointOrigin} · ` : ''}{t(`cap.effect.${server.effect}` as MessageKey)}
                  {server.toolCount !== null ? ` · ${t('cap.toolCount', { count: server.toolCount })}` : ''}
                </div>
                {operation?.state && operation.state !== 'connecting' ? (
                  <div className="pkg-detail-line" role="status">
                    {t(`cap.operation.${operation.state}` as MessageKey)}
                    {operation.toolCount !== undefined ? ` · ${t('cap.toolCount', { count: operation.toolCount })}` : ''}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </div>
      {notice ? <div className="pkg-detail-warn" role="alert">{notice}</div> : null}
    </div>
  )
}
