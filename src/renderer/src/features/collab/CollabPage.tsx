import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { Download, GitCompare, GitMerge, Play, RefreshCw, Upload, Users, X } from 'lucide-react'
import {
  COLLAB_REQUEST_NOTE_MAX,
  shortRef,
  type CollabBridge,
  type CollabComparison,
  type CollabFetchRecord,
  type CollabLocalProject,
  type CollabMergeRequest,
  type CollabMergeResult,
  type CollabOverview,
  type CollabPeerView,
  type CollabRemoteBranchView,
  type CollabRemoteProjectView
} from '../../../../shared/collab'
import type { PeerGrantView, PeerOperation, PeerProjectRef } from '../../../../shared/peer-protocol'
import { useI18n, type Lang } from '../../i18n'
import { fileStatusLabel, porcelainFileStatus } from '../../lib/file-status'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import {
  Badge,
  Button,
  Checkbox,
  CheckboxGroup,
  Dialog,
  IconButton,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Select,
  TextArea,
  TextField,
  type BadgeTone
} from '../../ui'
import { collabBridge, collabPeerBridge, parsePairLink, type CollabPeerBridge } from './bridge'
import { collabText, fill, formatCollabTime, type CollabText } from './collab-text'
import './collab.css'

type Tone = 'info' | 'error'

interface Message {
  tone: Tone
  text: string
}

type Notify = (tone: Tone, text: string) => void

type RunBusy = (key: string, work: () => Promise<void>) => Promise<void>

interface MergeRecord {
  source: string
  branch: string | null
  files: string[]
  at: number
}

interface ConfirmState {
  title: string
  body: string
  hint?: string
  confirmLabel: string
  danger?: boolean
  run: () => Promise<void>
}

interface MergeTarget {
  project: CollabLocalProject
  ref: string
  source: string
  requestId?: string
}

const REQUEST_OPS: PeerOperation[] = ['pull', 'push']
const POLL_MS = 5000

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortOid(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : ''
}

function remoteLabel(computer: string, branch: string): string {
  return `${computer}/${branch}`
}

function peerDisplayName(name: string): string {
  return name.replace(/^砚\s*·\s*/, '') || name
}

function useBusy(onError: (error: unknown) => void): [ReadonlySet<string>, RunBusy] {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const active = useRef(new Set<string>())
  const errorRef = useRef(onError)
  errorRef.current = onError
  const run = useCallback<RunBusy>(async (key, work) => {
    if (active.current.has(key)) return
    active.current.add(key)
    setBusy(new Set(active.current))
    try {
      await work()
    } catch (error) {
      errorRef.current(error)
    } finally {
      active.current.delete(key)
      setBusy(new Set(active.current))
    }
  }, [])
  return [busy, run]
}

function pruneRecords(records: Record<string, MergeRecord>, overview: CollabOverview, startedAt: number): Record<string, MergeRecord> {
  let changed = false
  const next: Record<string, MergeRecord> = {}
  for (const [id, record] of Object.entries(records)) {
    const project = overview.localProjects.find((item) => item.id === id)
    if (record.at < startedAt && !project?.mergeInProgress) {
      changed = true
      continue
    }
    next[id] = record
  }
  return changed ? next : records
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

function connectionBadge(peer: CollabPeerView, text: CollabText): { tone: BadgeTone; label: string } {
  const connection = peer.connection
  if (connection.state === 'connected') return { tone: 'run', label: text.stateConnected }
  if (connection.state === 'waiting') return { tone: 'stall', label: text.stateWaiting }
  if (connection.state === 'failed') return { tone: 'fail', label: text.stateFailed }
  return { tone: 'neutral', label: text.stateIdle }
}

function grantSummary(grant: PeerGrantView, text: CollabText): string {
  const projects = grant.projects.map((project) => project.name).join(' · ') || text.grantNone
  const ops = grant.operations.map((op) => text.ops[op] ?? op).join(' · ') || text.grantNone
  return fill(text.grantLine, { projects, ops })
}

function branchStates(branch: CollabRemoteBranchView, text: CollabText): Array<{ tone: BadgeTone; label: string }> {
  if (!branch.fetchedOid) return [{ tone: 'neutral', label: text.stateNotFetched }]
  const incoming = branch.incoming ?? 0
  const outgoing = branch.outgoing ?? 0
  const states: Array<{ tone: BadgeTone; label: string }> = []
  states.push(incoming > 0 ? { tone: 'accent', label: fill(text.stateIncoming, { n: incoming }) } : { tone: 'run', label: text.stateUpToDate })
  if (outgoing > 0) states.push({ tone: 'neutral', label: fill(text.stateOutgoing, { n: outgoing }) })
  if (branch.fetchedOid !== branch.oid) states.push({ tone: 'stall', label: text.stateStale })
  return states
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function MessageBar({ message, text, onDismiss }: { message: Message | null; text: CollabText; onDismiss(): void }): ReactElement {
  return (
    <div className="collab-msg-slot" data-testid="v3-collab-message">
      {message ? (
        <div className="collab-msg" data-tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'}>
          <p className="collab-msg__text">{message.text}</p>
          <IconButton aria-label={text.dismiss} size="sm" variant="ghost" onPress={onDismiss}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
      ) : null}
    </div>
  )
}

interface MergeNoticeProps {
  text: CollabText
  project: CollabLocalProject
  record: MergeRecord | undefined
  busy: boolean
  onAgent(): void
  onAbort(): void
}

function MergeNotice({ text, project, record, busy, onAgent, onAbort }: MergeNoticeProps): ReactElement {
  return (
    <div className="collab-merge" role="group" aria-label={fill(text.mergePending, { project: project.name })} data-testid={`v3-collab-merge-${project.id}`}>
      <p className="collab-merge__title">
        <Badge tone="stall">{text.local}</Badge>
        <span>{fill(text.mergePending, { project: project.name })}</span>
      </p>
      {record ? (
        <p className="collab-hint">{fill(text.mergePendingOf, { source: record.source, branch: record.branch ?? text.detached })}</p>
      ) : null}
      {record && record.files.length ? (
        <div className="collab-merge__files">
          <p className="collab-label">{text.conflictFiles}</p>
          <ul className="collab-mono-list">
            {record.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="collab-hint">{text.conflictUnknown}</p>
      )}
      <div className="collab-actions">
        <Button size="sm" variant="primary" isDisabled={busy} onPress={onAgent} data-testid="v3-collab-merge-agent">
          {text.resolveWithAgent}
        </Button>
        <Button size="sm" variant="danger" isDisabled={busy} onPress={onAbort} data-testid="v3-collab-merge-abort">
          {text.abortMerge}
        </Button>
      </div>
    </div>
  )
}

interface ComparePanelProps {
  bridge: CollabBridge
  text: CollabText
  lang: Lang
  localProjectId: string
  refName: string
  label: string
  version: string
}

type CompareState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: CollabComparison }

type DiffState = { path: string; status: 'loading' } | { path: string; status: 'error'; error: string } | { path: string; status: 'ready'; body: string }

function ComparePanel({ bridge, text, lang, localProjectId, refName, label, version }: ComparePanelProps): ReactElement {
  const [state, setState] = useState<CompareState>({ status: 'loading' })
  const [diff, setDiff] = useState<DiffState | null>(null)

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    setDiff(null)
    bridge.compare(localProjectId, refName).then(
      (result) => {
        if (!alive) return
        setState(result.ok ? { status: 'ready', data: result.data } : { status: 'error', error: result.error })
      },
      (error: unknown) => {
        if (alive) setState({ status: 'error', error: describe(error) })
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, localProjectId, refName, version])

  const openFile = (path: string | null): void => {
    if (!path) {
      setDiff(null)
      return
    }
    setDiff({ path, status: 'loading' })
    bridge.fileDiff(localProjectId, refName, path).then(
      (result) => {
        setDiff((current) =>
          current?.path !== path ? current : result.ok ? { path, status: 'ready', body: result.data } : { path, status: 'error', error: result.error }
        )
      },
      (error: unknown) => {
        setDiff((current) => (current?.path !== path ? current : { path, status: 'error', error: describe(error) }))
      }
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="collab-compare" data-testid="v3-collab-compare-panel" aria-busy="true">
        <p className="collab-hint">{text.compareLoading}</p>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="collab-compare" data-testid="v3-collab-compare-panel">
        <p className="collab-error" role="alert">
          {fill(text.compareFailed, { error: state.error })}
        </p>
      </div>
    )
  }

  const data = state.data
  return (
    <div className="collab-compare" role="region" aria-label={`${text.compare} · ${label}`} data-testid="v3-collab-compare-panel">
      {data.base ? <p className="collab-hint collab-mono">{fill(text.compareBase, { base: shortOid(data.base) })}</p> : null}
      <div className="collab-compare__block">
        <p className="collab-label">{fill(text.compareCommits, { n: data.commits.length })}</p>
        {data.commits.length === 0 ? (
          <p className="collab-hint">{text.compareNoCommits}</p>
        ) : (
          <ol className="collab-commits">
            {data.commits.map((commit) => (
              <li key={commit.oid} className="collab-commit">
                <span className="collab-commit__oid">{shortOid(commit.oid)}</span>
                <span className="collab-commit__subject">{commit.subject}</span>
                <span className="collab-commit__meta">
                  {commit.author} · {formatCollabTime(commit.committedAt, lang)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="collab-compare__block">
        <p className="collab-label">{fill(text.compareFiles, { n: data.files.length })}</p>
        {data.files.length === 0 ? (
          <p className="collab-hint">{text.compareNoFiles}</p>
        ) : (
          <ListBox
            aria-label={fill(text.compareFiles, { n: data.files.length })}
            className="collab-files"
            selectionMode="single"
            selectedKeys={diff ? [diff.path] : []}
            onSelectionChange={(keys) => {
              if (keys === 'all') return
              const first = [...keys][0]
              openFile(first === undefined ? null : String(first))
            }}
            data-testid="v3-collab-files"
          >
            {data.files.map((file) => (
              <ListBoxItem key={file.path} id={file.path} textValue={file.path} className="collab-file">
                <span className="collab-file__status">{fileStatusLabel(porcelainFileStatus(file.status), lang)}</span>
                <span className="collab-file__path" title={file.path}>
                  {file.path}
                </span>
                {file.additions !== null || file.deletions !== null ? (
                  <span className="collab-file__stat">
                    <span data-kind="add">+{file.additions ?? 0}</span>
                    <span data-kind="del">−{file.deletions ?? 0}</span>
                  </span>
                ) : null}
              </ListBoxItem>
            ))}
          </ListBox>
        )}
      </div>
      {diff ? (
        <div className="collab-diff-wrap" data-testid="v3-collab-diff">
          <div className="collab-diff-head">
            <p className="collab-label collab-mono">{fill(text.diffOf, { path: diff.path })}</p>
            <Button size="sm" variant="ghost" onPress={() => setDiff(null)}>
              {text.diffHide}
            </Button>
          </div>
          {diff.status === 'loading' ? (
            <p className="collab-hint">{text.diffLoading}</p>
          ) : diff.status === 'error' ? (
            <p className="collab-error" role="alert">
              {fill(text.diffFailed, { error: diff.error })}
            </p>
          ) : diff.body.trim() === '' ? (
            <p className="collab-hint">{text.diffEmpty}</p>
          ) : (
            <pre className="collab-diff" tabIndex={0} aria-label={fill(text.diffOf, { path: diff.path })}>
              {diff.body.replace(/\n$/, '').split('\n').map((line, index) => (
                <span key={index} className="collab-diff__line" data-kind={diffLineKind(line)}>
                  {`${line}\n`}
                </span>
              ))}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

interface PeerCardProps {
  peer: CollabPeerView
  text: CollabText
  busy: ReadonlySet<string>
  canConnect: boolean
  onConnect(ops: PeerOperation[], note: string): void
  onDisconnect(): void
  onRemove(): void
}

function PeerCard({ peer, text, busy, canConnect, onConnect, onDisconnect, onRemove }: PeerCardProps): ReactElement {
  const [ops, setOps] = useState<string[]>(() => [...REQUEST_OPS])
  const [note, setNote] = useState('')
  const connection = peer.connection
  const grant = connection.state === 'connected' ? connection.grant : null
  const waiting = connection.state === 'waiting' || busy.has(`connect:${peer.id}`)
  const badge = connectionBadge(peer, text)
  const chosen = REQUEST_OPS.filter((op) => ops.includes(op))

  return (
    <li className="collab-card collab-peer" data-testid={`v3-collab-peer-${peer.id}`} data-state={connection.state}>
      <div className="collab-peer__head">
        <span className="collab-peer__name">{peer.computer}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="collab-peer__addr collab-mono" title={peer.address}>
          {peer.address}
        </span>
      </div>
      {connection.state === 'failed' ? (
        <p className="collab-error">{fill(text.failedReason, { error: connection.error })}</p>
      ) : null}
      {grant ? (
        <p className="collab-hint">{grantSummary(grant, text)}</p>
      ) : (
        <div className="collab-peer__request">
          <CheckboxGroup
            label={text.requestOps}
            value={ops}
            isDisabled={waiting || !canConnect}
            onChange={setOps}
            errorMessage={text.needOps}
            isInvalid={chosen.length === 0}
          >
            <div className="collab-inline">
              {REQUEST_OPS.map((op) => (
                <Checkbox key={op} value={op}>
                  {text.ops[op]}
                </Checkbox>
              ))}
            </div>
          </CheckboxGroup>
          <TextField
            label={text.note}
            value={note}
            maxLength={200}
            isDisabled={waiting || !canConnect}
            onChange={setNote}
            className="collab-grow"
          />
        </div>
      )}
      <div className="collab-actions">
        {grant || connection.state === 'waiting' ? (
          <Button
            size="sm"
            isDisabled={!canConnect || busy.has(`disconnect:${peer.id}`)}
            onPress={onDisconnect}
            data-testid={`v3-collab-disconnect-${peer.id}`}
          >
            {text.disconnect}
          </Button>
        ) : null}
        {grant ? null : (
          <Button
            size="sm"
            variant="primary"
            isDisabled={!canConnect || waiting || chosen.length === 0}
            onPress={() => onConnect(chosen, note.trim())}
            data-testid={`v3-collab-connect-${peer.id}`}
          >
            {waiting ? text.waiting : text.connect}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!canConnect || busy.has(`remove:${peer.id}`)}
          onPress={onRemove}
          data-testid={`v3-collab-remove-${peer.id}`}
        >
          {text.remove}
        </Button>
      </div>
    </li>
  )
}

interface PairFormProps {
  text: CollabText
  disabled: boolean
  pending: boolean
  notify: Notify
  onPair(address: string, code: string): Promise<boolean>
}

function PairForm({ text, disabled, pending, notify, onPair }: PairFormProps): ReactElement {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')

  const absorbLink = (value: string): boolean => {
    const link = parsePairLink(value)
    if (!link || !link.address || link.code.length !== 6) return false
    setAddress(link.address)
    setCode(link.code)
    notify('info', text.pairLinkParsed)
    return true
  }

  const ready = !disabled && address.trim() !== '' && code.length === 6

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready || pending) return
    void onPair(address.trim(), code).then((ok) => {
      if (!ok) return
      setAddress('')
      setCode('')
    })
  }

  return (
    <form className="collab-pair" onSubmit={submit} data-testid="v3-collab-pair-form">
      <p className="collab-label">{text.pairTitle}</p>
      <p className="collab-hint">{text.pairHint}</p>
      <div className="collab-pair__row">
        <TextField
          label={text.address}
          placeholder={text.addressPlaceholder}
          value={address}
          isDisabled={disabled}
          onChange={(value) => {
            if (!absorbLink(value)) setAddress(value)
          }}
          className="collab-pair__address"
          data-testid="v3-collab-pair-address"
        />
        <TextField
          label={text.code}
          placeholder={text.codePlaceholder}
          value={code}
          inputMode="numeric"
          maxLength={200}
          isDisabled={disabled}
          onChange={(value) => {
            if (!absorbLink(value)) setCode(value.replace(/\D/g, '').slice(0, 6))
          }}
          className="collab-pair__code"
          data-testid="v3-collab-pair-code"
        />
        <Button type="submit" variant="primary" isDisabled={!ready} isPending={pending} data-testid="v3-collab-pair">
          {text.pair}
        </Button>
      </div>
    </form>
  )
}

interface RemoteProjectPanelProps {
  bridge: CollabBridge
  text: CollabText
  lang: Lang
  peer: CollabPeerView
  grant: PeerGrantView
  project: PeerProjectRef
  localProjects: CollabLocalProject[]
  fetched: CollabFetchRecord[]
  reloadTick: number
  notify: Notify
  onOverviewChanged(): Promise<unknown>
  onMerge(target: MergeTarget): void
  onContinue(project: CollabLocalProject, ref: string, importId?: string): Promise<void>
  onLocalChange(key: string, localId: string | null | undefined): void
  mergeNotice(project: CollabLocalProject): ReactNode
}

function RemoteProjectPanel({
  bridge,
  text,
  lang,
  peer,
  grant,
  project,
  localProjects,
  fetched,
  reloadTick,
  notify,
  onOverviewChanged,
  onMerge,
  onContinue,
  onLocalChange,
  mergeNotice
}: RemoteProjectPanelProps): ReactElement {
  const panelKey = `${peer.id}:${project.id}`
  const [view, setView] = useState<CollabRemoteProjectView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const [openCompare, setOpenCompare] = useState<string | null>(null)
  const [pushBranch, setPushBranch] = useState<string | null>(null)
  const [withRequest, setWithRequest] = useState(false)
  const [requestTitle, setRequestTitle] = useState('')
  const [requestNote, setRequestNote] = useState('')
  const [busy, run] = useBusy((cause) => notify('error', describe(cause)))
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const id = ++seq.current
    setLoading(true)
    try {
      const result = await bridge.remoteProject(peer.id, project.id)
      if (id !== seq.current) return
      if (result.ok) {
        setView(result.data)
        setError('')
      } else {
        setError(result.error)
      }
    } catch (cause) {
      if (id === seq.current) setError(describe(cause))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [bridge, peer.id, project.id])

  useEffect(() => {
    void load()
  }, [load, reloadTick])

  const selectedId = chosen !== undefined ? chosen : view ? view.localProjectId ?? view.suggestedLocalProjectId : null
  const localProject = selectedId ? localProjects.find((item) => item.id === selectedId) ?? null : null
  const effectiveGrant = view?.grant ?? grant
  const canPull = effectiveGrant.operations.includes('pull')
  const canPush = effectiveGrant.operations.includes('push')
  const usable = !!localProject && localProject.isRepo
  const suggestedOnly = !!view && !view.localProjectId && !!selectedId && selectedId === view.suggestedLocalProjectId && chosen === undefined
  const decided = chosen !== undefined || !!view

  useEffect(() => {
    onLocalChange(panelKey, selectedId)
  }, [onLocalChange, panelKey, selectedId])

  useEffect(() => () => onLocalChange(panelKey, undefined), [onLocalChange, panelKey])

  const ensureLinked = async (): Promise<boolean> => {
    if (!localProject) {
      notify('error', text.needLocal)
      return false
    }
    if (view?.localProjectId === localProject.id) return true
    const result = await bridge.link(peer.id, project.id, localProject.id)
    if (!result.ok) {
      notify('error', fill(text.linkFailed, { error: result.error }))
      return false
    }
    return true
  }

  const changeLocal = (key: string | number | null): void => {
    const next = key === null || key === '' ? null : String(key)
    if (next === selectedId && (next === null || view?.localProjectId === next)) return
    setChosen(next)
    setOpenCompare(null)
    void run('link', async () => {
      const result = await bridge.link(peer.id, project.id, next)
      if (!result.ok) {
        notify('error', fill(text.linkFailed, { error: result.error }))
        return
      }
      const name = next ? localProjects.find((item) => item.id === next)?.name ?? next : ''
      notify('info', next ? fill(text.linked, { remote: project.name, project: name }) : fill(text.unlinked, { remote: project.name }))
      await Promise.all([load(), onOverviewChanged()])
    })
  }

  const importIdFor = (branch: CollabRemoteBranchView): string | undefined =>
    fetched.find((record) => record.peerId === peer.id && record.remoteProjectId === project.id && record.branch === branch.name)?.importIds[0]

  const fetchBranch = (branch: CollabRemoteBranchView): void => {
    const label = remoteLabel(peer.computer, branch.name)
    void run(`fetch:${branch.name}`, async () => {
      if (!(await ensureLinked())) return
      const result = await bridge.fetch(peer.id, project.id, branch.name)
      if (!result.ok) {
        notify('error', fill(text.fetchFailed, { error: result.error }))
        return
      }
      const data = result.data
      let summary = data.incoming === 0 && data.outgoing === 0 ? text.fetchUpToDate : fill(text.fetchCounts, { incoming: data.incoming, outgoing: data.outgoing })
      if (data.imported.length) summary += fill(text.fetchImported, { n: data.imported.length })
      if (data.importErrors.length) summary += fill(text.fetchImportErrors, { n: data.importErrors.length, errors: data.importErrors.join(' · ') })
      notify(data.importErrors.length ? 'error' : 'info', fill(text.fetched, { ref: label, summary }))
      await Promise.all([load(), onOverviewChanged()])
    })
  }

  const continueBranch = (branch: CollabRemoteBranchView): void => {
    if (!localProject) return
    const target = localProject
    void run(`continue:${branch.name}`, () => onContinue(target, branch.trackingRef, importIdFor(branch)))
  }

  const pushTarget = localProject && pushBranch && localProject.branches.includes(pushBranch) ? pushBranch : localProject?.currentBranch ?? null

  const push = (): void => {
    if (!localProject) {
      notify('error', text.needLocal)
      return
    }
    if (!pushTarget) {
      notify('error', text.needBranch)
      return
    }
    if (withRequest && !requestTitle.trim()) {
      notify('error', text.needTitle)
      return
    }
    const target = localProject
    const branch = pushTarget
    void run('push', async () => {
      const result = await bridge.push({
        peerId: peer.id,
        remoteProjectId: project.id,
        localProjectId: target.id,
        branch,
        ...(withRequest ? { request: { title: requestTitle.trim(), note: requestNote.trim() } } : {})
      })
      if (!result.ok) {
        notify('error', fill(text.pushFailed, { error: result.error }))
        return
      }
      const ref = shortRef(result.data.trackingRef)
      notify('info', fill(result.data.requestId ? text.pushedWithRequest : text.pushed, { computer: peer.computer, ref }))
      setWithRequest(false)
      setRequestTitle('')
      setRequestNote('')
      await Promise.all([load(), onOverviewChanged()])
    })
  }

  const remoteTag = fill(text.remote, { computer: peer.computer })
  const branches = view?.branches ?? []
  const mergeBlocked = !!localProject?.mergeInProgress

  return (
    <article className="collab-card collab-project" data-testid={`v3-collab-project-${peer.id}-${project.id}`} aria-label={`${remoteTag} · ${project.name}`}>
      <header className="collab-project__head">
        <h4 className="collab-project__name">{project.name}</h4>
        <Badge tone="accent">{remoteTag}</Badge>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={14} aria-hidden />}
          isPending={loading}
          onPress={() => void load()}
          className="collab-project__refresh"
        >
          {text.refresh}
        </Button>
      </header>

      <div className="collab-local">
        <Select
          label={`${text.local} · ${text.localProject}`}
          placeholder={text.localProjectPlaceholder}
          selectedKey={selectedId ?? ''}
          disabledKeys={localProjects.filter((item) => !item.isRepo).map((item) => item.id)}
          isDisabled={busy.has('link')}
          onSelectionChange={(key) => changeLocal(key)}
          className="collab-grow"
          data-testid="v3-collab-local-select"
        >
          <ListBoxItem id="" textValue={text.localNone}>
            {text.localNone}
          </ListBoxItem>
          {localProjects.map((item) => (
            <ListBoxItem key={item.id} id={item.id} textValue={item.name}>
              {item.isRepo ? item.name : `${item.name}${text.notRepo}`}
            </ListBoxItem>
          ))}
        </Select>
        {localProject ? (
          <p className="collab-hint">
            <Badge>{text.local}</Badge>{' '}
            {localProject.currentBranch ? fill(text.currentBranch, { branch: localProject.currentBranch }) : text.detached}
          </p>
        ) : null}
      </div>
      {suggestedOnly ? <p className="collab-hint">{text.suggested}</p> : null}
      {!decided ? null : !localProject ? (
        <p className="collab-note" role="note">
          {text.needLocal}
        </p>
      ) : !localProject.isRepo ? (
        <p className="collab-note" role="note">
          {fill(text.localNotRepo, { project: localProject.name })}
        </p>
      ) : null}
      {!canPull ? (
        <p className="collab-note" role="note">
          {text.noPull}
        </p>
      ) : null}
      {localProject ? mergeNotice(localProject) : null}

      {error ? (
        <div className="collab-error-row">
          <p className="collab-error" role="alert">
            {fill(text.projectFailed, { error })}
          </p>
          <Button size="sm" onPress={() => void load()}>
            {text.retry}
          </Button>
        </div>
      ) : null}

      <section className="collab-branches" aria-label={`${remoteTag} · ${text.branchesTitle}`}>
        <p className="collab-label">{text.branchesTitle}</p>
        {!view && loading ? (
          <p className="collab-hint" aria-busy="true">
            {text.projectLoading}
          </p>
        ) : view && branches.length === 0 ? (
          <p className="collab-hint">{text.branchesEmpty}</p>
        ) : (
          <ul className="collab-branch-list">
            {branches.map((branch) => {
              const label = remoteLabel(peer.computer, branch.name)
              const fetchedHere = !!branch.fetchedOid
              const compareOpen = openCompare === branch.name && fetchedHere && usable
              const sessionTitles = branch.sessions.map((session) => session.title).join('\n')
              return (
                <li key={branch.name} className="collab-branch" data-testid={`v3-collab-branch-${branch.name}`}>
                  <div className="collab-branch__line">
                    <span className="collab-branch__name" title={branch.trackingRef}>
                      {label}
                    </span>
                    {branch.current ? <Badge>{text.remoteCurrent}</Badge> : null}
                    {branchStates(branch, text).map((state) => (
                      <Badge key={state.label} tone={state.tone}>
                        {state.label}
                      </Badge>
                    ))}
                  </div>
                  <p className="collab-branch__commit">
                    <span className="collab-branch__subject" title={branch.subject}>
                      {branch.subject || shortOid(branch.oid)}
                    </span>
                    <span className="collab-branch__meta">
                      {branch.author} · {formatCollabTime(branch.committedAt, lang)}
                    </span>
                  </p>
                  <p className="collab-branch__sessions" title={sessionTitles || undefined}>
                    {branch.sessions.length ? fill(text.sessions, { n: branch.sessions.length }) : text.sessionsNone}
                  </p>
                  <div className="collab-actions">
                    <Button
                      size="sm"
                      icon={<Download size={14} aria-hidden />}
                      isPending={busy.has(`fetch:${branch.name}`)}
                      isDisabled={!usable || !canPull}
                      onPress={() => fetchBranch(branch)}
                      data-testid="v3-collab-fetch"
                    >
                      {text.fetch}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<GitCompare size={14} aria-hidden />}
                      isDisabled={!usable || !fetchedHere}
                      title={fetchedHere ? undefined : text.needFetch}
                      aria-expanded={compareOpen}
                      onPress={() => setOpenCompare((current) => (current === branch.name ? null : branch.name))}
                      data-testid="v3-collab-compare"
                    >
                      {compareOpen ? text.compareHide : text.compare}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<GitMerge size={14} aria-hidden />}
                      isDisabled={!usable || !fetchedHere || mergeBlocked || (branch.incoming ?? 0) === 0}
                      title={fetchedHere ? undefined : text.needFetch}
                      onPress={() => {
                        if (localProject) onMerge({ project: localProject, ref: branch.trackingRef, source: label })
                      }}
                      data-testid="v3-collab-merge"
                    >
                      {text.merge}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Play size={14} aria-hidden />}
                      isPending={busy.has(`continue:${branch.name}`)}
                      isDisabled={!usable || !fetchedHere}
                      title={fetchedHere ? text.continueHint : text.needFetch}
                      onPress={() => continueBranch(branch)}
                      data-testid="v3-collab-continue"
                    >
                      {text.continue}
                    </Button>
                  </div>
                  {compareOpen && localProject ? (
                    <ComparePanel
                      bridge={bridge}
                      text={text}
                      lang={lang}
                      localProjectId={localProject.id}
                      refName={branch.trackingRef}
                      label={label}
                      version={`${localProject.currentBranch ?? ''}:${branch.fetchedOid ?? ''}:${branch.incoming ?? ''}:${branch.outgoing ?? ''}`}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="collab-push" aria-label={fill(text.pushTitle, { computer: peer.computer })} data-testid="v3-collab-push">
        <p className="collab-label">{fill(text.pushTitle, { computer: peer.computer })}</p>
        <p className="collab-hint">{text.pushHint}</p>
        {!canPush ? (
          <p className="collab-note" role="note">
            {text.noPush}
          </p>
        ) : null}
        <div className="collab-push__row">
          <Select
            label={`${text.local} · ${text.pushBranch}`}
            placeholder={text.pushBranchPlaceholder}
            selectedKey={pushTarget}
            isDisabled={!usable || !canPush || !localProject?.branches.length}
            onSelectionChange={(key) => setPushBranch(key === null ? null : String(key))}
            className="collab-grow"
            data-testid="v3-collab-push-branch"
          >
            {(localProject?.branches ?? []).map((branch) => (
              <ListBoxItem key={branch} id={branch} textValue={branch}>
                {branch}
              </ListBoxItem>
            ))}
          </Select>
          <Checkbox isSelected={withRequest} isDisabled={!usable || !canPush} onChange={setWithRequest} data-testid="v3-collab-push-request">
            {text.pushRequest}
          </Checkbox>
        </div>
        {withRequest ? (
          <div className="collab-push__request">
            <TextField label={text.requestTitle} value={requestTitle} maxLength={200} onChange={setRequestTitle} data-testid="v3-collab-request-title" />
            <TextArea
              label={text.requestNote}
              value={requestNote}
              rows={3}
              maxLength={COLLAB_REQUEST_NOTE_MAX}
              onChange={setRequestNote}
              data-testid="v3-collab-request-note"
            />
          </div>
        ) : null}
        <div className="collab-actions">
          <Button
            size="sm"
            variant="primary"
            icon={<Upload size={14} aria-hidden />}
            isPending={busy.has('push')}
            isDisabled={!usable || !canPush || !pushTarget}
            onPress={push}
            data-testid="v3-collab-push-submit"
          >
            {text.push}
          </Button>
        </div>
      </section>
    </article>
  )
}

interface RequestItemProps {
  bridge: CollabBridge
  text: CollabText
  lang: Lang
  request: CollabMergeRequest
  localProject: CollabLocalProject | null
  busy: ReadonlySet<string>
  onMerge(target: MergeTarget): void
  onClose(request: CollabMergeRequest): void
}

function RequestItem({ bridge, text, lang, request, localProject, busy, onMerge, onClose }: RequestItemProps): ReactElement {
  const [comparing, setComparing] = useState(false)
  const incoming = request.direction === 'incoming'
  const open = request.status === 'open'
  const peerName = peerDisplayName(request.peerName)
  const source = incoming ? remoteLabel(peerName, request.branch) : request.branch
  const statusTone: BadgeTone = request.status === 'open' ? 'accent' : request.status === 'merged' ? 'run' : 'neutral'
  const usable = !!localProject && localProject.isRepo

  return (
    <li className="collab-request" data-testid={`v3-collab-request-${request.id}`} data-status={request.status}>
      <div className="collab-request__head">
        <strong className="collab-request__title">{request.title || source}</strong>
        <Badge tone={statusTone}>{text.requestStatus[request.status]}</Badge>
      </div>
      <p className="collab-request__meta">
        <Badge tone={incoming ? 'accent' : 'neutral'}>{incoming ? fill(text.remote, { computer: peerName }) : text.local}</Badge>
        <span>{fill(incoming ? text.requestFrom : text.requestTo, { peer: peerName })}</span>
        <span>· {request.projectName}</span>
        <span className="collab-mono">· {source}</span>
        {incoming && localProject ? (
          <span>
            → {text.local} · {localProject.name}
          </span>
        ) : null}
        <span>· {formatCollabTime(request.createdAt, lang)}</span>
      </p>
      {request.note ? <p className="collab-request__note">{request.note}</p> : null}
      {incoming && open && !localProject ? <p className="collab-note">{text.requestNoLocal}</p> : null}
      {incoming && open ? (
        <div className="collab-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<GitCompare size={14} aria-hidden />}
            isDisabled={!usable}
            aria-expanded={comparing}
            onPress={() => setComparing((value) => !value)}
            data-testid="v3-collab-request-compare"
          >
            {comparing ? text.compareHide : text.compare}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<GitMerge size={14} aria-hidden />}
            isDisabled={!usable || !!localProject?.mergeInProgress}
            onPress={() => {
              if (localProject) onMerge({ project: localProject, ref: request.trackingRef, source, requestId: request.id })
            }}
            data-testid="v3-collab-request-merge"
          >
            {text.mergeConfirm}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isPending={busy.has(`close:${request.id}`)}
            onPress={() => onClose(request)}
            data-testid="v3-collab-request-close"
          >
            {text.closeRequest}
          </Button>
        </div>
      ) : null}
      {comparing && usable && localProject ? (
        <ComparePanel
          bridge={bridge}
          text={text}
          lang={lang}
          localProjectId={localProject.id}
          refName={request.trackingRef}
          label={source}
          version={`${localProject.currentBranch ?? ''}:${localProject.mergeInProgress ? 1 : 0}:${request.status}`}
        />
      ) : null}
    </li>
  )
}

export function CollabPage(): ReactElement {
  const { lang } = useI18n()
  const text = collabText(lang)
  const bridge = useMemo(() => collabBridge(), [])
  const peerBridge = useMemo<CollabPeerBridge | null>(() => collabPeerBridge(), [])
  const [overview, setOverview] = useState<CollabOverview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState<Message | null>(null)
  const [records, setRecords] = useState<Record<string, MergeRecord>>({})
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [panelLocals, setPanelLocals] = useState<Record<string, string | null>>({})
  const notify = useCallback<Notify>((tone, value) => setMessage({ tone, text: value }), [])
  const [busy, run] = useBusy((error) => notify('error', describe(error)))
  const seq = useRef(0)
  const inflight = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    const id = ++seq.current
    const startedAt = Date.now()
    inflight.current += 1
    try {
      const next = await bridge.overview()
      if (id !== seq.current) return
      setOverview(next)
      setLoadError('')
      setRecords((prev) => pruneRecords(prev, next, startedAt))
    } catch (error) {
      if (id === seq.current) setLoadError(describe(error))
    } finally {
      inflight.current -= 1
    }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    void refresh()
    const tick = (): void => {
      if (document.visibilityState !== 'visible' || inflight.current > 0) return
      void refresh()
    }
    const timer = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [bridge, refresh])

  const refreshAll = useCallback(async (): Promise<void> => {
    await refresh()
    setReloadTick((value) => value + 1)
  }, [refresh])

  const setPanelLocal = useCallback((key: string, localId: string | null | undefined): void => {
    setPanelLocals((prev) => {
      if (localId === undefined) return withoutKey(prev, key)
      return prev[key] === localId ? prev : { ...prev, [key]: localId }
    })
  }, [])

  const localById = useMemo(() => new Map((overview?.localProjects ?? []).map((item) => [item.id, item])), [overview])

  const openSessionWithPrompt = useCallback(
    async (cwd: string, projectId: string, prompt: string): Promise<boolean> => {
      const created = await useStore.getState().newSession({ cwd, projectId, scope: 'project' })
      if (!created.ok) {
        notify('error', fill(text.sessionFailed, { error: created.error ?? '' }))
        return false
      }
      useStore.getState().setSessionDraft(prompt)
      useUiV3.getState().navigate({ name: 'chat' })
      return true
    },
    [notify, text]
  )

  const handleMergeResult = useCallback(
    (target: MergeTarget, result: CollabMergeResult): void => {
      const id = target.project.id
      if (result.ok) {
        setRecords((prev) => withoutKey(prev, id))
        notify('info', result.merged ? fill(text.merged, { message: target.source }) : text.mergeNoop)
        return
      }
      const conflicts = result.conflicts ?? []
      if (conflicts.length) {
        setRecords((prev) => ({ ...prev, [id]: { source: target.source, branch: target.project.currentBranch, files: conflicts, at: Date.now() } }))
        notify('error', fill(text.mergeConflicts, { project: target.project.name }))
        return
      }
      notify('error', fill(text.mergeFailed, { error: result.error }))
    },
    [notify, text]
  )

  const requestMerge = useCallback(
    (target: MergeTarget): void => {
      if (!bridge) return
      setConfirm({
        title: text.mergeTitle,
        body: fill(text.mergeBody, { source: target.source, project: target.project.name, branch: target.project.currentBranch ?? text.detached }),
        hint: text.mergeHint,
        confirmLabel: text.mergeConfirm,
        run: async () => {
          const result = await bridge.merge(target.project.id, target.ref, target.requestId)
          handleMergeResult(target, result)
          await refreshAll()
        }
      })
    },
    [bridge, handleMergeResult, refreshAll, text]
  )

  const continueFrom = useCallback(
    async (project: CollabLocalProject, ref: string, importId?: string): Promise<void> => {
      if (!bridge) return
      const result = await bridge.continueFrom(project.id, ref, importId)
      if (!result.ok) {
        notify('error', fill(text.continueFailed, { error: result.error }))
        return
      }
      await openSessionWithPrompt(result.data.worktree, project.id, result.data.prompt)
    },
    [bridge, notify, openSessionWithPrompt, text]
  )

  const resolveWithAgent = useCallback(
    (project: CollabLocalProject): void => {
      const record = records[project.id]
      const prompt = text.agentPrompt({
        project: project.name,
        cwd: project.cwd,
        source: record?.source ?? null,
        branch: record?.branch ?? project.currentBranch,
        files: record?.files ?? []
      })
      void run(`agent:${project.id}`, async () => {
        await openSessionWithPrompt(project.cwd, project.id, prompt)
      })
    },
    [openSessionWithPrompt, records, run, text]
  )

  const abortMerge = useCallback(
    (project: CollabLocalProject): void => {
      if (!bridge) return
      setConfirm({
        title: text.abortTitle,
        body: fill(text.abortBody, { project: project.name }),
        confirmLabel: text.abortMerge,
        danger: true,
        run: async () => {
          const result = await bridge.abortMerge(project.id)
          if (!result.ok) {
            notify('error', fill(text.abortFailed, { error: result.error }))
          } else {
            setRecords((prev) => withoutKey(prev, project.id))
            notify('info', fill(text.aborted, { project: project.name }))
          }
          await refreshAll()
        }
      })
    },
    [bridge, notify, refreshAll, text]
  )

  const mergeNotice = useCallback(
    (project: CollabLocalProject): ReactNode => {
      const record = records[project.id]
      if (!project.mergeInProgress && !record) return null
      return (
        <MergeNotice
          key={`merge-${project.id}`}
          text={text}
          project={project}
          record={record}
          busy={busy.has(`agent:${project.id}`)}
          onAgent={() => resolveWithAgent(project)}
          onAbort={() => abortMerge(project)}
        />
      )
    },
    [abortMerge, busy, records, resolveWithAgent, text]
  )

  const pair = async (address: string, code: string): Promise<boolean> => {
    if (!peerBridge) return false
    let ok = false
    await run('pair', async () => {
      const result = await peerBridge.pair(address, code)
      if (result.ok) {
        ok = true
        notify('info', fill(text.paired, { computer: result.data.computer }))
      } else {
        notify('error', fill(text.pairFailed, { error: result.error }))
      }
      await refresh()
    })
    return ok
  }

  const connect = (peer: CollabPeerView, ops: PeerOperation[], note: string): void => {
    if (!peerBridge) return
    if (!ops.length) {
      notify('error', text.needOps)
      return
    }
    void run(`connect:${peer.id}`, async () => {
      const pending = peerBridge.connect(peer.id, ops, note)
      void refresh()
      const result = await pending
      if (result.ok) notify('info', fill(text.connected, { computer: peer.computer }))
      else notify('error', fill(text.connectFailed, { computer: peer.computer, error: result.error }))
      await refreshAll()
    })
  }

  const disconnect = (peer: CollabPeerView): void => {
    if (!peerBridge) return
    void run(`disconnect:${peer.id}`, async () => {
      await peerBridge.disconnect(peer.id)
      notify('info', fill(text.disconnected, { computer: peer.computer }))
      await refresh()
    })
  }

  const remove = (peer: CollabPeerView): void => {
    if (!peerBridge) return
    setConfirm({
      title: text.removeTitle,
      body: fill(text.removeBody, { computer: peer.computer }),
      confirmLabel: text.remove,
      danger: true,
      run: async () => {
        const removed = await peerBridge.remove(peer.id)
        if (removed) notify('info', fill(text.removed, { computer: peer.computer }))
        else notify('error', fill(text.removeFailed, { computer: peer.computer }))
        await refresh()
      }
    })
  }

  const closeRequest = (request: CollabMergeRequest): void => {
    if (!bridge) return
    void run(`close:${request.id}`, async () => {
      const result = await bridge.closeRequest(request.id)
      if (result.ok) notify('info', fill(text.closed, { title: request.title || request.branch }))
      else notify('error', fill(text.closeFailed, { error: result.error }))
      await refresh()
    })
  }

  const confirmRun = async (): Promise<void> => {
    if (!confirm || confirmBusy) return
    const current = confirm
    setConfirmBusy(true)
    try {
      await current.run()
    } catch (error) {
      notify('error', describe(error))
    } finally {
      setConfirmBusy(false)
      setConfirm(null)
    }
  }

  const head = (
    <header className="collab-head">
      <h1 className="collab-title">
        <Users size={18} aria-hidden /> {text.title}
      </h1>
      {bridge ? (
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} onPress={() => void refreshAll()} data-testid="v3-collab-refresh">
          {text.refresh}
        </Button>
      ) : null}
    </header>
  )

  if (!bridge) {
    return (
      <div className="collab-page" data-testid="v3-collab-page" data-wired="0">
        {head}
        <p className="collab-lede" data-testid="v3-collab-lede">
          {text.lede}
        </p>
        <p className="collab-note" role="note" data-testid="v3-collab-missing">
          {text.bridgeMissing}
        </p>
      </div>
    )
  }

  const peers = overview?.peers ?? []
  const connectedPeers = peers.flatMap((peer) => (peer.connection.state === 'connected' ? [{ peer, grant: peer.connection.grant }] : []))
  const shownLocals = new Set(Object.values(panelLocals).filter((id): id is string => !!id))
  const looseMerges = (overview?.localProjects ?? []).filter((item) => (item.mergeInProgress || records[item.id]) && !shownLocals.has(item.id))
  const requests = overview?.requests ?? []
  const incomingRequests = requests.filter((request) => request.direction === 'incoming')
  const outgoingRequests = requests.filter((request) => request.direction === 'outgoing')

  const requestList = (list: CollabMergeRequest[], empty: string): ReactElement =>
    list.length === 0 ? (
      <p className="collab-hint">{empty}</p>
    ) : (
      <ul className="collab-request-list">
        {list.map((request) => (
          <RequestItem
            key={request.id}
            bridge={bridge}
            text={text}
            lang={lang}
            request={request}
            localProject={localById.get(request.localProjectId) ?? null}
            busy={busy}
            onMerge={requestMerge}
            onClose={closeRequest}
          />
        ))}
      </ul>
    )

  return (
    <div className="collab-page" data-testid="v3-collab-page" data-wired="1" aria-busy={!overview && !loadError ? true : undefined}>
      {head}
      <p className="collab-lede" data-testid="v3-collab-lede">
        {text.lede}
      </p>
      <MessageBar message={message} text={text} onDismiss={() => setMessage(null)} />
      {loadError ? (
        <div className="collab-error-row">
          <p className="collab-error" role="alert">
            {fill(text.loadFailed, { error: loadError })}
          </p>
          <Button size="sm" onPress={() => void refreshAll()}>
            {text.retry}
          </Button>
        </div>
      ) : null}
      {!overview && !loadError ? <p className="collab-hint">{text.loading}</p> : null}

      {looseMerges.length ? (
        <section className="collab-section" aria-label={text.local} data-testid="v3-collab-local-merges">
          {looseMerges.map((item) => mergeNotice(item))}
        </section>
      ) : null}

      <section className="collab-section" aria-labelledby="collab-peers-title" data-testid="v3-collab-peers">
        <h2 className="collab-section__title" id="collab-peers-title">
          {text.peersTitle}
        </h2>
        <p className="collab-hint">{text.peersHint}</p>
        {!peerBridge ? (
          <p className="collab-note" role="note">
            {text.peerMissing}
          </p>
        ) : null}
        {overview && peers.length === 0 ? <p className="collab-hint">{text.peersEmpty}</p> : null}
        {peers.length ? (
          <ul className="collab-peer-list">
            {peers.map((peer) => (
              <PeerCard
                key={peer.id}
                peer={peer}
                text={text}
                busy={busy}
                canConnect={!!peerBridge}
                onConnect={(ops, note) => connect(peer, ops, note)}
                onDisconnect={() => disconnect(peer)}
                onRemove={() => remove(peer)}
              />
            ))}
          </ul>
        ) : null}
        <PairForm text={text} disabled={!peerBridge} pending={busy.has('pair')} notify={notify} onPair={pair} />
      </section>

      <section className="collab-section" aria-labelledby="collab-remote-title" data-testid="v3-collab-remote">
        <h2 className="collab-section__title" id="collab-remote-title">
          {text.projectsTitle}
        </h2>
        {connectedPeers.length === 0 ? (
          <p className="collab-hint">{text.projectsEmpty}</p>
        ) : (
          connectedPeers.map(({ peer, grant }) => (
            <div className="collab-remote" key={peer.id} data-testid={`v3-collab-remote-${peer.id}`}>
              <h3 className="collab-remote__title">
                <Badge tone="accent">{fill(text.remote, { computer: peer.computer })}</Badge>
              </h3>
              {grant.projects.length === 0 ? (
                <p className="collab-hint">{text.grantNoProjects}</p>
              ) : (
                grant.projects.map((project) => (
                  <RemoteProjectPanel
                    key={`${peer.id}:${project.id}`}
                    bridge={bridge}
                    text={text}
                    lang={lang}
                    peer={peer}
                    grant={grant}
                    project={project}
                    localProjects={overview?.localProjects ?? []}
                    fetched={overview?.fetched ?? []}
                    reloadTick={reloadTick}
                    notify={notify}
                    onOverviewChanged={refresh}
                    onMerge={requestMerge}
                    onContinue={continueFrom}
                    onLocalChange={setPanelLocal}
                    mergeNotice={mergeNotice}
                  />
                ))
              )}
            </div>
          ))
        )}
      </section>

      <section className="collab-section" aria-labelledby="collab-requests-title" data-testid="v3-collab-requests">
        <h2 className="collab-section__title" id="collab-requests-title">
          {text.requestsTitle}
        </h2>
        <div className="collab-requests">
          <div className="collab-requests__group" data-testid="v3-collab-requests-incoming">
            <h3 className="collab-label">{text.incoming}</h3>
            {requestList(incomingRequests, text.requestsEmptyIn)}
          </div>
          <div className="collab-requests__group" data-testid="v3-collab-requests-outgoing">
            <h3 className="collab-label">{text.outgoing}</h3>
            {requestList(outgoingRequests, text.requestsEmptyOut)}
          </div>
        </div>
      </section>

      <ModalOverlay
        isDismissable={!confirmBusy}
        isOpen={!!confirm}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirm(null)
        }}
      >
        <Modal>
          <Dialog title={confirm?.title} closeLabel={text.cancel} data-testid="v3-collab-confirm">
            <p className="collab-confirm__body">{confirm?.body}</p>
            {confirm?.hint ? <p className="collab-hint">{confirm.hint}</p> : null}
            <footer className="collab-confirm__foot">
              <Button isDisabled={confirmBusy} onPress={() => setConfirm(null)}>
                {text.cancel}
              </Button>
              <Button
                variant={confirm?.danger ? 'danger' : 'primary'}
                isPending={confirmBusy}
                onPress={() => void confirmRun()}
                data-testid="v3-collab-confirm-ok"
              >
                {confirm?.confirmLabel}
              </Button>
            </footer>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  )
}
