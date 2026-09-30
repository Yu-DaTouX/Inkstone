import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { ConsentSection } from './ConsentSection'
import { ComputerUseSection } from './ComputerUseSection'
import type {
  CapabilitySearchResultView,
  CapabilitySettingsSnapshot,
  CapabilityVerificationStatus
} from '../../../../shared/ipc'
import type { SearchBackendStatus } from '../../../../shared/search'
import { Button, Disclosure, SettingRow } from '../ui'

const STRATEGIES = ['existing-only', 'search-and-recommend', 'auto-connect'] as const

export function CapabilitiesTab(): React.JSX.Element {
  const t = useT()
  const tk = (key: string): string => t(key as MessageKey)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const session = useStore(s => s.session)
  const send = useStore(s => s.send)
  const closeSettings = useStore(s => s.closeSettings)
  const strategy = settings?.capabilityStrategy ?? 'auto-connect'
  const [snapshot, setSnapshot] = useState<CapabilitySettingsSnapshot | null>(null)
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState<CapabilitySearchResultView | null>(null)
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState('')
  const [operations, setOperations] = useState<Record<string, CapabilityVerificationStatus>>({})
  const mounted = useRef(true)
  /* 按需求找能力（实施-25 P17）：只说「缺什么、怎么接」，不装不改配置 */
  /*
   * 外部工具与浏览器（实施-27 D4）：搜索后端与浏览器扩展的状态。
   * 只读探针（`yan:search:doctor`）—— 砚不装、不升级，只告诉你缺什么。
   */
  const [backend, setBackend] = useState<SearchBackendStatus | null>(null)
  const [backendBusy, setBackendBusy] = useState(false)
  /* 探针自己失败了（IPC 抛错）与「后端不可用」是两回事，不能都显示成「检测中…」 */
  const [backendFailed, setBackendFailed] = useState(false)
  /** 用户点了「安装 OpenCLI」：进行中 / 结果（needsNode 时给 Node.js 下载入口） */
  const [install, setInstall] = useState<{ busy: boolean; ok?: boolean; needsNode?: boolean; text?: string } | null>(null)

  const checkBackend = useCallback(async (): Promise<void> => {
    setBackendBusy(true)
    try {
      const next = await window.yan.search.doctor()
      if (mounted.current) {
        setBackend(next)
        setBackendFailed(false)
      }
    } catch {
      if (mounted.current) {
        setBackend(null)
        setBackendFailed(true)
      }
    } finally {
      if (mounted.current) setBackendBusy(false)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    /* 内置能力只在「插件」一组里列一次（带说明），这里不重复 */
    const next = await window.yan.capabilities.snapshot()
    if (mounted.current) setSnapshot(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : tk('cap.loadFailed')))
    return () => {
      mounted.current = false
    }
  }, [refresh])

  useEffect(() => {
    void checkBackend()
  }, [checkBackend])

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
    <div className="ui-rows" data-testid="set-capabilities">
      <SettingRow
        data-testid="cap-strategy"
        name={t('cap.strategyTitle')}
        desc={t(`cap.strategyDesc.${strategy}` as MessageKey)}
        ctlClassName="seg"
        ctlProps={{ role: 'group', 'aria-label': t('cap.strategyTitle') }}
      >
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
      </SettingRow>
      <div className="ui-row set-row-col" data-testid="cap-skills">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('cap.skillsTitle')}</div>
          <div className="ui-row-desc">{t('cap.skillsDesc')}</div>
        </div>
        <div className="pkg-list">
          {!snapshot || snapshot.skills.length === 0 ? <div className="ui-row-desc">{t('cap.emptySkills')}</div> : null}
          {snapshot?.skills.map((skill) => (
            <div className="pkg-item" key={skill.id} data-testid="cap-skill">
              <div className="pkg-item-main">
                <span className="pkg-name" title={skill.title}>{skill.title}</span>
                <span className="pkg-spacer" />
                <span className="pkg-scope user">{t('cap.ready')}</span>
              </div>
              {skill.description ? <div className="pkg-detail-line">{skill.description}</div> : null}
            </div>
          ))}
        </div>
      </div>

      {snapshot?.nativeMcpAvailable ? <SettingRow col name={t('cap.nativeMcpTitle')} desc={t('cap.nativeMcpDesc')}>
        <Button data-testid="cap-native-mcp" disabled={!session?.sessionId || !!session.isAgentRunning || !!session.isStreaming || !!session.isCompacting} onClick={() => { closeSettings(); void send('/mcp') }}>{t('cap.nativeMcpOpen')}</Button>
      </SettingRow> : null}
      <div className="ui-row set-row-col" data-testid="cap-mcp">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('cap.mcpTitle')}</div>
          <div className="ui-row-desc">{t('cap.mcpDesc')}</div>
        </div>
        {snapshot?.configWarning ? <div className="pkg-detail-warn">{t('cap.configWarning')}</div> : null}
        <div className="pkg-list">
          {!snapshot || snapshot.servers.length === 0 ? <div className="ui-row-desc">{t('cap.emptyMcp')}</div> : null}
          {snapshot?.servers.map((server) => {
            const operation = operations[server.id]
            return (
              <article className="pkg-item" key={server.id} data-testid="cap-mcp-server">
                <div className="pkg-item-main">
                  <span className="pkg-name" title={server.title}>{server.title}</span>
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
      <div className="ui-row set-row-col" data-testid="cap-search">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('cap.searchTitle')}</div>
          <div className="ui-row-desc">{t('cap.searchDesc')}</div>
        </div>
        <form className="pkg-install-row" onSubmit={(event) => void runSearch(event)}>
          <input
            className="ui-input"
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
            {search.candidates.length === 0 ? <div className="ui-row-desc">{t('cap.noCandidates')}</div> : null}
            <div className="pkg-list" data-testid="cap-search-results">
              {search.candidates.map((candidate) => (
                <article className="pkg-item" key={candidate.candidateId} data-testid="cap-candidate">
                  <div className="pkg-item-main">
                    <span className="pkg-name" title={candidate.title}>{candidate.title}</span>
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

      <div className="ui-rows">
        <ComputerUseSection />
      </div>

      <Disclosure title={t('set.extTools')} testId="cap-external" defaultOpen={!!backend && !backend.available}>
        <div className="ui-rows">
          {/* 外部工具与浏览器（实施-27 D4）：搜索后端在不在、扩展连没连 */}
          <div className="ui-row set-row-col" data-testid="cap-ext-tools">
            <div className="ui-row-label">
              <div className="ui-row-name">{t('set.extTools')}</div>
              <div className="ui-row-desc">{t('set.extToolsDesc')}</div>
            </div>
            <div className="ui-row-desc" data-testid="cap-search-backend">
              <strong>{t('set.searchBackend')}</strong>
              {' — '}
              {backend === null
                ? backendFailed
                  ? t('set.searchBackendProbeFailed')
                  : t('set.searchBackendUnknown')
                : backend.available
                  ? backend.code === 'extension_not_connected'
                    ? t('set.searchBackendExtOff', { version: backend.version ?? '?' })
                    : t('set.searchBackendReady', { version: backend.version ?? '?' })
                  : backend.code === 'backend_unusable'
                    ? t('set.searchBackendUnusable', { version: backend.version ?? '?' })
                    : t('set.searchBackendMissing')}
              {backend && !backend.available ? (
                <div className="ui-row-desc">
                  {backend.code === 'backend_unusable'
                    ? t('set.searchBackendUnusableHint')
                    : /node/i.test(backend.detail ?? '')
                      ? t('set.searchBackendNodeHint')
                      : t('set.searchBackendHint')}
                </div>
              ) : null}
              {/*
                不可用时一律把 detail 摆出来 —— 它才是真正的原因：可能是「没装 opencli」，
                也可能是「装了 opencli 但 PATH 里没 node」（只看上面那句「安装：npm i -g …」
                会把后一种人带去重装已经装好的东西）。
              */}
              {backend && !backend.available && backend.detail ? (
                <div className="ui-row-desc" data-testid="cap-search-backend-detail">
                  {backend.detail.length > 240 ? backend.detail.slice(0, 240) + '…' : backend.detail}
                </div>
              ) : null}
              {backend && backend.available && backend.code === 'extension_not_connected' ? (
                <div className="ui-row-desc">{t('set.searchBackendExtHint')}</div>
              ) : null}
              {/* 安装渠道：命令行后端（npm）与浏览器扩展（Chrome 应用商店 / GitHub 发布包） */}
              {backend && !backend.available && backend.code !== 'backend_unusable' ? (
                <div className="set-install-actions" data-testid="cap-search-install">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={install?.busy}
                    onClick={() => {
                      setInstall({ busy: true })
                      void window.yan.search.installBackend().then(async (r) => {
                        setInstall({ busy: false, ok: r.ok, needsNode: r.needsNode, text: r.ok ? t('set.opencliInstalled') : [r.error, r.log].filter(Boolean).join('\n') })
                        if (r.ok) await checkBackend()
                      }).catch((e: unknown) => {
                        /* IPC 被拒绝时也要解除忙碌态，否则按钮永远停在「安装中」 */
                        setInstall({ busy: false, ok: false, text: e instanceof Error ? e.message : String(e) })
                      })
                    }}
                  >
                    {install?.busy ? t('set.opencliInstalling') : t('set.opencliInstall')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText('npm install -g @jackwener/opencli')}>
                    {t('set.opencliCopyCmd')}
                  </Button>
                  {install?.needsNode || /node|npm/i.test(backend.detail ?? '') ? (
                    <Button size="sm" variant="ghost" onClick={() => void window.yan.browser.openExternal('https://nodejs.org/zh-cn/download')}>
                      {t('set.opencliGetNode')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {install?.text ? (
                <div className={`ui-row-desc set-install-log ${install.ok ? '' : 'err'}`} data-testid="cap-search-install-result">{install.text}</div>
              ) : null}
              {backend?.available ? (
                <div className="set-install-actions" data-testid="cap-search-extension">
                  <span className="ui-row-desc">{t('set.opencliExtension')}</span>
                  <Button size="sm" onClick={() => void window.yan.browser.openExternal('https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk')}>
                    {t('set.opencliExtStore')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void window.yan.browser.openExternal('https://github.com/jackwener/OpenCLI/releases')}>
                    {t('set.opencliExtZip')}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="ui-row-ctl">
              <Button data-testid="cap-search-recheck" disabled={backendBusy} onClick={() => void checkBackend()}>
                {backendBusy ? t('set.searchBackendChecking') : t('set.extRecheck')}
              </Button>
            </div>
          </div>

          <div className="ui-row set-row-col" data-testid="cap-browsers">
            <div className="ui-row-label">
              <div className="ui-row-name">{t('set.browsers')}</div>
              <div className="ui-row-desc">{t('set.browsersDesc')}</div>
            </div>
            <div className="ui-row-desc">
              <strong>{t('set.browserBuiltin')}</strong> — {t('set.browserBuiltinDesc')}
            </div>
            <div className="ui-row-desc">
              <strong>{t('set.browserUser')}</strong> — {t('set.browserUserDesc')}
            </div>
          </div>
        </div>
      </Disclosure>
      <Disclosure title={t('consent.title')} testId="cap-consent">
        <ConsentSection />
      </Disclosure>
      {notice ? <div className="pkg-detail-warn" role="alert">{notice}</div> : null}
    </div>
  )
}
