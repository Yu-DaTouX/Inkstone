import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Button, EmptyState } from '../ui'
import {
  PEER_OPERATIONS,
  type PeerGrantView,
  type PeerImportView,
  type PeerOperation,
  type PeerStatusView
} from '../../../../shared/peer-protocol'
import type { PeerHistoryMessage, PeerSessionRow } from '../../../../shared/ipc'

function formatTime(at: number | undefined): string {
  if (!at) return '—'
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at)
}

type Browse = {
  peerId: string
  projects: Array<{ id: string; name: string }>
  sessions: PeerSessionRow[]
  open?: { sessionId: string; messages: PeerHistoryMessage[] }
}

/**
 * 设置 · 砚互联（需求稿 5.4 / 第 6 节）。
 *
 * 上半：这台电脑被别的砚连接时，当前有效的「本次连接」授权与撤销（审批弹窗是全局的）。
 * 下半：这台电脑去连接别的砚 —— 配对、申请连接、在授权范围内浏览、复制副本、导入项目记忆。
 * 查看与复制分开：查看不在本机留副本；复制形成带来源的副本，缺失的附件如实标出。
 */
export function PeerTab() {
  const t = useT()
  const localProjects = useStore((s) => s.settings?.projects ?? []).filter((project) => !project.archived)
  const [status, setStatus] = useState<PeerStatusView | null>(null)
  const [hostGrants, setHostGrants] = useState<PeerGrantView[]>([])
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [ops, setOps] = useState<Record<string, PeerOperation[]>>({})
  const [note, setNote] = useState('')
  const [browse, setBrowse] = useState<Browse | null>(null)
  const [message, setMessage] = useState('')
  const [taskText, setTaskText] = useState<Record<string, string>>({})
  const [knowledgeTarget, setKnowledgeTarget] = useState('')
  const [viewing, setViewing] = useState<{ id: string; messages: PeerHistoryMessage[] } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [next, remote] = await Promise.all([window.yan.peer.status(), window.yan.remote.status()])
      setStatus(next)
      setHostGrants(remote?.grants ?? [])
    } catch {
      /* 下一轮再试 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 3000)
    return () => window.clearInterval(id)
  }, [refresh])

  const run = async (action: () => Promise<{ ok: boolean; error?: string } | boolean | void>, okText?: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await action()
      if (result && typeof result === 'object' && !result.ok) setNotice({ kind: 'err', text: result.error ?? t('peer.failed') })
      else if (okText) setNotice({ kind: 'ok', text: okText })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const opsOf = (peerId: string): PeerOperation[] => ops[peerId] ?? ['read']
  const toggleOp = (peerId: string, op: PeerOperation): void =>
    setOps((all) => {
      const list = opsOf(peerId)
      return { ...all, [peerId]: list.includes(op) ? list.filter((item) => item !== op) : [...list, op] }
    })

  const loadSessions = async (peerId: string): Promise<void> => {
    const result = await window.yan.peer.sessions(peerId)
    if (!result.ok) return setNotice({ kind: 'err', text: result.error })
    setBrowse({ peerId, projects: result.data.projects, sessions: result.data.sessions })
  }

  const openSession = async (peerId: string, sessionId: string): Promise<void> => {
    const result = await window.yan.peer.history(peerId, sessionId)
    if (!result.ok) return setNotice({ kind: 'err', text: result.error })
    setBrowse((current) => (current ? { ...current, open: { sessionId, messages: result.data.messages } } : current))
  }

  const openImport = async (item: PeerImportView): Promise<void> => {
    const result = await window.yan.peer.readImport(item.id)
    if (!result.ok) return setNotice({ kind: 'err', text: result.error })
    setViewing({ id: item.id, messages: result.data.messages })
  }

  return (
    <div className="ui-rows" data-testid="settings-peer">
      {/* ① 这台电脑被连接 */}
      <div className="ui-row col" data-testid="peer-host">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('peer.hostTitle')}</div>
          <div className="ui-row-desc">{t('peer.hostDesc')}</div>
        </div>
        {hostGrants.length === 0 ? <EmptyState>{t('peer.hostEmpty')}</EmptyState> : null}
        {hostGrants.map((grant) => (
          <div className="peer-card" key={grant.connectionId} data-testid="peer-host-grant">
            <div className="peer-card-head">
              <span className="ui-row-name">{grant.deviceName}</span>
              <Badge tone={grant.activatedAt ? 'ok' : 'neutral'}>{grant.activatedAt ? t('peer.live') : t('peer.pendingStream')}</Badge>
            </div>
            <div className="ui-row-desc">
              {t('peer.grantLine', {
                projects: grant.projects.map((p) => p.name).join('、'),
                ops: grant.operations.map((op) => t(`peer.op.${op}` as 'peer.op.read')).join('、'),
                at: formatTime(grant.grantedAt)
              })}
            </div>
            <div className="btn-row">
              <Button size="sm" onClick={() => void run(() => window.yan.peer.hostRevoke(grant.connectionId))}>
                {t('peer.revoke')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* ② 连接其他砚 */}
      <div className="ui-row col" data-testid="peer-client">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('peer.clientTitle')}</div>
          <div className="ui-row-desc">{t('peer.clientDesc')}</div>
        </div>
        <div className="btn-row">
          <input className="ui-input" placeholder="100.101.102.103:37892" value={address} onChange={(e) => setAddress(e.target.value)} data-testid="peer-address" />
          <input className="ui-input num peer-code" placeholder={t('peer.codePlaceholder')} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="peer-code" />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !address.trim() || code.length !== 6}
            onClick={() =>
              void run(async () => {
                const result = await window.yan.peer.pair(address, code)
                if (result.ok) {
                  setAddress('')
                  setCode('')
                }
                return result
              }, t('peer.paired'))
            }
            data-testid="peer-pair"
          >
            {t('peer.pair')}
          </Button>
        </div>

        {status && status.peers.length === 0 ? <EmptyState>{t('peer.noPeers')}</EmptyState> : null}
        {status?.peers.map((peer) => {
          const connection = peer.connection
          const grant = connection.state === 'connected' ? connection.grant : null
          return (
            <div className="peer-card" key={peer.id} data-testid="peer-card">
              <div className="peer-card-head">
                <span className="ui-row-name">{peer.computer}</span>
                <span className="set-path">{peer.address}</span>
                {grant ? (
                  <Badge tone="ok">{t('peer.connected')}</Badge>
                ) : connection.state === 'waiting' ? (
                  <Badge tone="accent">{t('peer.waiting')}</Badge>
                ) : (
                  <Badge>{t('peer.notConnected')}</Badge>
                )}
              </div>
              {connection.state === 'failed' ? <div className="set-warn">{connection.error}</div> : null}
              {grant ? (
                <div className="ui-row-desc">
                  {t('peer.myGrantLine', {
                    projects: grant.projects.map((p) => p.name).join('、'),
                    ops: grant.operations.map((op) => t(`peer.op.${op}` as 'peer.op.read')).join('、')
                  })}
                </div>
              ) : (
                <>
                  <div className="peer-ops" role="group" aria-label={t('peer.requestOps')}>
                    {PEER_OPERATIONS.map((op) => (
                      <label className="peer-approval-option" key={op}>
                        <input type="checkbox" checked={opsOf(peer.id).includes(op)} onChange={() => toggleOp(peer.id, op)} />
                        <span>{t(`peer.op.${op}` as 'peer.op.read')}</span>
                      </label>
                    ))}
                  </div>
                  <input className="ui-input" placeholder={t('peer.notePlaceholder')} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                </>
              )}
              <div className="btn-row">
                {grant ? (
                  <>
                    <Button size="sm" onClick={() => void loadSessions(peer.id)} data-testid="peer-browse">
                      {t('peer.browse')}
                    </Button>
                    <Button size="sm" onClick={() => void run(() => window.yan.peer.disconnect(peer.id))}>
                      {t('peer.disconnect')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || connection.state === 'waiting' || !opsOf(peer.id).length}
                    onClick={() => void run(() => window.yan.peer.connect(peer.id, opsOf(peer.id), note), t('peer.connectedNotice'))}
                    data-testid="peer-connect"
                  >
                    {connection.state === 'waiting' ? t('peer.waiting') : t('peer.connect')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void run(() => window.yan.peer.remove(peer.id))}>
                  {t('peer.remove')}
                </Button>
              </div>

              {grant && browse?.peerId === peer.id ? (
                <div className="peer-browse" data-testid="peer-browse-list">
                  {browse.projects.map((project) => (
                    <div className="peer-project" key={project.id}>
                      <div className="peer-card-head">
                        <span className="ui-row-name">{project.name}</span>
                        {grant.operations.includes('transfer') ? (
                          <>
                            <select className="ui-input" value={knowledgeTarget} onChange={(e) => setKnowledgeTarget(e.target.value)} aria-label={t('peer.knowledgeTarget')}>
                              <option value="">{t('peer.knowledgeTarget')}</option>
                              {localProjects.map((local) => (
                                <option key={local.id} value={local.id}>
                                  {local.name}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              disabled={!knowledgeTarget || busy}
                              onClick={() =>
                                void run(async () => {
                                  const result = await window.yan.peer.importKnowledge(peer.id, project.id, knowledgeTarget)
                                  if (result.ok) setNotice({ kind: 'ok', text: t('peer.knowledgeDone', { accepted: result.data.accepted, rejected: result.data.rejected }) })
                                  return result
                                })
                              }
                            >
                              {t('peer.importKnowledge')}
                            </Button>
                          </>
                        ) : null}
                      </div>
                      {grant.operations.includes('send') ? (
                        <div className="btn-row" data-testid="peer-start-task">
                          <input
                            className="ui-input"
                            value={taskText[project.id] ?? ''}
                            maxLength={20000}
                            placeholder={t('peer.startPlaceholder')}
                            aria-label={t('peer.startPlaceholder')}
                            onChange={(e) => setTaskText((all) => ({ ...all, [project.id]: e.target.value }))}
                          />
                          <Button
                            size="sm"
                            disabled={!(taskText[project.id] ?? '').trim() || busy}
                            onClick={() =>
                              void run(async () => {
                                const result = await window.yan.peer.startSession(peer.id, project.id, taskText[project.id] ?? '')
                                if (result.ok) {
                                  setTaskText((all) => ({ ...all, [project.id]: '' }))
                                  await loadSessions(peer.id)
                                }
                                return result
                              }, t('peer.started'))
                            }
                          >
                            {t('peer.startTask')}
                          </Button>
                        </div>
                      ) : null}
                      {browse.sessions
                        .filter((session) => session.projectId === project.id)
                        .map((session) => (
                          <div className="peer-session" key={session.id}>
                            <span className="peer-session-title">{session.title || session.id}</span>
                            <span className="ui-row-desc">{t('peer.sessionMeta', { n: session.messageCount, at: formatTime(session.updatedAt) })}</span>
                            <Button size="sm" onClick={() => void openSession(peer.id, session.id)}>
                              {t('peer.view')}
                            </Button>
                            {grant.operations.includes('transfer') ? (
                              <Button size="sm" disabled={busy} onClick={() => void run(() => window.yan.peer.importSession(peer.id, session.id), t('peer.imported'))} data-testid="peer-import">
                                {t('peer.copy')}
                              </Button>
                            ) : null}
                          </div>
                        ))}
                    </div>
                  ))}
                  {browse.open ? (
                    <div className="peer-history" data-testid="peer-history">
                      <div className="ui-row-desc">{t('peer.viewingRemote')}</div>
                      {browse.open.messages.map((item) => (
                        <div className="peer-message" key={item.id}>
                          <span className="peer-role">{item.role}</span>
                          <span className="peer-text">{(item.text ?? '').slice(0, 600)}</span>
                        </div>
                      ))}
                      {grant.operations.includes('send') ? (
                        <div className="btn-row">
                          <input className="ui-input" value={message} maxLength={20000} placeholder={t('peer.sendPlaceholder')} onChange={(e) => setMessage(e.target.value)} />
                          <Button
                            size="sm"
                            disabled={!message.trim() || busy}
                            onClick={() =>
                              void run(async () => {
                                const result = await window.yan.peer.send(peer.id, browse.open!.sessionId, message)
                                if (result.ok) setMessage('')
                                return result
                              }, t('peer.sent'))
                            }
                          >
                            {t('peer.send')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* ③ 已导入的副本 */}
      <div className="ui-row col" data-testid="peer-imports">
        <div className="ui-row-label">
          <div className="ui-row-name">{t('peer.importsTitle')}</div>
          <div className="ui-row-desc">{t('peer.importsDesc')}</div>
        </div>
        {status && status.imports.length === 0 ? <EmptyState>{t('peer.noImports')}</EmptyState> : null}
        {status?.imports.map((item) => {
          const missing = item.artifacts.filter((artifact) => artifact.status !== 'copied')
          return (
            <div className="peer-card" key={item.id} data-testid="peer-import-item">
              <div className="peer-card-head">
                <span className="ui-row-name">{item.title || item.sourceSessionId}</span>
                <Badge>{t('peer.copyBadge')}</Badge>
              </div>
              <div className="ui-row-desc">
                {t('peer.importLine', { computer: item.computer, project: item.projectName, exported: formatTime(item.exportedAt), imported: formatTime(item.importedAt), n: item.messageCount })}
              </div>
              {item.artifacts.length ? (
                <div className={missing.length ? 'set-warn' : 'ui-row-desc'}>
                  {t('peer.artifactLine', { copied: item.artifacts.length - missing.length, total: item.artifacts.length })}
                  {missing.length ? ` · ${t('peer.artifactMissing', { names: missing.map((a) => a.filename).join('、') })}` : ''}
                </div>
              ) : null}
              <div className="btn-row">
                <Button size="sm" onClick={() => void openImport(item)}>
                  {t('peer.view')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void window.yan.peer.revealImport(item.id)}>
                  {t('peer.openFolder')}
                </Button>
              </div>
              {viewing?.id === item.id ? (
                <div className="peer-history">
                  {viewing.messages.map((entry) => (
                    <div className="peer-message" key={entry.id}>
                      <span className="peer-role">{entry.role}</span>
                      <span className="peer-text">{(entry.text ?? '').slice(0, 600)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {notice ? (
        <div className={notice.kind === 'err' ? 'set-warn' : 'ui-row-desc'} role={notice.kind === 'err' ? 'alert' : 'status'}>
          {notice.text}
        </div>
      ) : null}
    </div>
  )
}
