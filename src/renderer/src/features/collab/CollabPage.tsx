import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { Download, GitCompare, GitMerge, Play, RefreshCw, Upload, Users } from 'lucide-react'
import {
  COLLAB_REQUEST_NOTE_MAX,
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
  Card,
  CardHead,
  CardTitle,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogFooter,
  DiffStat,
  EmptyState,
  ListBox,
  ListBoxItem,
  MiddleTruncate,
  Modal,
  ModalOverlay,
  Notice,
  PageHeader,
  Select,
  SettingSection,
  Spinner,
  TextArea,
  TextField,
  Tooltip,
  TooltipTrigger,
  showToast,
  type BadgeTone
} from '../../ui'
import { DiffView } from '../diff'
import { collabBridge, collabPeerBridge, parsePairLink, type CollabPeerBridge } from './bridge'
import { collabText, fill, formatCollabTime, peerDisplayName, type CollabText } from './collab-text'
import { HostGrants } from './HostGrants'
import { InviteCard } from './InviteCard'
import { usePendingPairInvite } from './pending-invite'
import { useRemoteStatus } from './remote-status'
import './collab.css'

type Tone = 'info' | 'fail'

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
const TOAST_SUMMARY_MAX = 140
const FAIL_TOAST_MS = 10000

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortOid(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : ''
}

function remoteLabel(computer: string, branch: string): string {
  return `${computer}/${branch}`
}

function splitMessage(value: string): { summary: string; folded: boolean } {
  const trimmed = value.trim()
  const firstLine = trimmed.split('\n')[0] ?? ''
  const clipped = firstLine.length > TOAST_SUMMARY_MAX ? `${firstLine.slice(0, TOAST_SUMMARY_MAX)}…` : firstLine
  return { summary: clipped, folded: clipped !== trimmed }
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
  if (connection.state === 'connected') return { tone: 'ok', label: text.stateConnected }
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
  states.push(incoming > 0 ? { tone: 'accent', label: fill(text.stateIncoming, { n: incoming }) } : { tone: 'ok', label: text.stateUpToDate })
  if (outgoing > 0) states.push({ tone: 'neutral', label: fill(text.stateOutgoing, { n: outgoing }) })
  if (branch.fetchedOid !== branch.oid) states.push({ tone: 'stall', label: text.stateStale })
  return states
}

function Loading({ label }: { label: string }): ReactElement {
  return (
    <p className="collab-hint collab-loading" aria-busy="true">
      <Spinner size="xs" />
      <span>{label}</span>
    </p>
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
  const title = fill(text.mergePending, { project: project.name })
  return (
    <Notice tone="stall" role="group" aria-label={title} title={title} data-testid={`v3-collab-merge-${project.id}`}>
      <div className="collab-stack">
        {record ? <p className="collab-hint">{fill(text.mergePendingOf, { source: record.source, branch: record.branch ?? text.detached })}</p> : null}
        {record && record.files.length ? (
          <div className="collab-stack">
            <p className="collab-label">{text.conflictFiles}</p>
            <ul className="collab-file-list">
              {record.files.map((file) => (
                <li key={file}>
                  <MiddleTruncate value={file} className="collab-code" />
                </li>
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
    </Notice>
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
      <Card quiet padding="sm" className="collab-card collab-compare" data-testid="v3-collab-compare-panel" aria-busy="true">
        <Loading label={text.compareLoading} />
      </Card>
    )
  }
  if (state.status === 'error') {
    return (
      <Card quiet padding="sm" className="collab-card collab-compare" data-testid="v3-collab-compare-panel">
        <Notice tone="fail" compact>
          {fill(text.compareFailed, { error: state.error })}
        </Notice>
      </Card>
    )
  }

  const data = state.data
  const [diffTitleBefore = '', diffTitleAfter = ''] = text.diffOf.split('{path}')
  return (
    <Card quiet padding="sm" className="collab-card collab-compare" role="region" aria-label={`${text.compare} · ${label}`} data-testid="v3-collab-compare-panel">
      {data.base ? <p className="collab-hint">{fill(text.compareBase, { base: shortOid(data.base) })}</p> : null}
      <div className="collab-stack">
        <p className="collab-label">{fill(text.compareCommits, { n: data.commits.length })}</p>
        {data.commits.length === 0 ? (
          <p className="collab-hint">{text.compareNoCommits}</p>
        ) : (
          <ol className="collab-commits">
            {data.commits.map((commit) => (
              <li key={commit.oid} className="collab-commit">
                <span className="collab-commit__oid collab-code">{shortOid(commit.oid)}</span>
                <span className="collab-commit__subject">{commit.subject}</span>
                <span className="collab-commit__meta">
                  {commit.author} · {formatCollabTime(commit.committedAt, lang)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="collab-stack">
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
              <ListBoxItem key={file.path} id={file.path} textValue={file.path}>
                <span className="collab-file">
                  <span className="collab-file__status">{fileStatusLabel(porcelainFileStatus(file.status), lang)}</span>
                  <MiddleTruncate value={file.path} className="collab-file__path" />
                  {file.additions !== null || file.deletions !== null ? <DiffStat added={file.additions ?? 0} removed={file.deletions ?? 0} /> : null}
                </span>
              </ListBoxItem>
            ))}
          </ListBox>
        )}
      </div>
      {diff ? (
        <div className="collab-stack" data-testid="v3-collab-diff">
          <div className="collab-diff-head">
            <p className="collab-label collab-diff-head__title">
              {diffTitleBefore ? <span className="collab-diff-head__affix">{diffTitleBefore}</span> : null}
              <MiddleTruncate value={diff.path} className="collab-code" />
              {diffTitleAfter ? <span className="collab-diff-head__affix">{diffTitleAfter}</span> : null}
            </p>
            <Button size="sm" variant="ghost" onPress={() => setDiff(null)}>
              {text.diffHide}
            </Button>
          </div>
          {diff.status === 'loading' ? (
            <Loading label={text.diffLoading} />
          ) : diff.status === 'error' ? (
            <Notice tone="fail" compact>
              {fill(text.diffFailed, { error: diff.error })}
            </Notice>
          ) : diff.body.trim() === '' ? (
            <p className="collab-hint">{text.diffEmpty}</p>
          ) : (
            <div className="collab-diff" tabIndex={0} aria-label={fill(text.diffOf, { path: diff.path })}>
              <DiffView patch={diff.body} embedded showFileHeader={false} lang={lang} />
            </div>
          )}
        </div>
      ) : null}
    </Card>
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
    <Card as="li" className="collab-card" data-testid={`v3-collab-peer-${peer.id}`} data-state={connection.state}>
      <CardHead className="collab-card__head">
        <CardTitle className="collab-card__title">{peer.computer}</CardTitle>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <MiddleTruncate value={peer.address} className="collab-card__meta collab-peer__addr" />
      </CardHead>
      {connection.state === 'failed' ? (
        <Notice tone="fail" compact>{fill(text.failedReason, { error: connection.error })}</Notice>
      ) : null}
      {grant ? (
        <p className="collab-hint">{grantSummary(grant, text)}</p>
      ) : (
        <div className="collab-row">
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
    </Card>
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
  const invite = usePendingPairInvite((state) => state.invite)

  useEffect(() => {
    if (!invite) return
    const taken = usePendingPairInvite.getState().take()
    if (!taken) return
    setAddress(taken.address)
    setCode(taken.code)
    notify('info', text.pairInviteReceived)
  }, [invite, notify, text.pairInviteReceived])

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
    <Card className="collab-card">
      <CardHead>
        <CardTitle>{text.pairTitle}</CardTitle>
      </CardHead>
      <form className="collab-stack" onSubmit={submit} data-testid="v3-collab-pair-form">
        <p className="collab-hint">{text.pairHint}</p>
        <div className="collab-row">
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
    </Card>
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
  const [busy, run] = useBusy((cause) => notify('fail', describe(cause)))
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
      notify('fail', text.needLocal)
      return false
    }
    if (view?.localProjectId === localProject.id) return true
    const result = await bridge.link(peer.id, project.id, localProject.id)
    if (!result.ok) {
      notify('fail', fill(text.linkFailed, { error: result.error }))
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
        notify('fail', fill(text.linkFailed, { error: result.error }))
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
        notify('fail', fill(text.fetchFailed, { error: result.error }))
        return
      }
      const data = result.data
      let summary = data.incoming === 0 && data.outgoing === 0 ? text.fetchUpToDate : fill(text.fetchCounts, { incoming: data.incoming, outgoing: data.outgoing })
      if (data.imported.length) summary += fill(text.fetchImported, { n: data.imported.length })
      if (data.importErrors.length) summary += fill(text.fetchImportErrors, { n: data.importErrors.length, errors: data.importErrors.join(' · ') })
      notify(data.importErrors.length ? 'fail' : 'info', fill(text.fetched, { ref: label, summary }))
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
      notify('fail', text.needLocal)
      return
    }
    if (!pushTarget) {
      notify('fail', text.needBranch)
      return
    }
    if (withRequest && !requestTitle.trim()) {
      notify('fail', text.needTitle)
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
        notify('fail', fill(text.pushFailed, { error: result.error }))
        return
      }
      notify('info', fill(result.data.requestId ? text.pushedWithRequest : text.pushed, { computer: peer.computer, branch }))
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
    <Card as="article" className="collab-card" data-testid={`v3-collab-project-${peer.id}-${project.id}`} aria-label={`${remoteTag} · ${project.name}`}>
      <CardHead className="collab-card__head">
        <CardTitle className="collab-card__title" role="heading" aria-level={4}>
          {project.name}
        </CardTitle>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} isPending={loading} onPress={() => void load()} className="collab-card__end">
          {text.refresh}
        </Button>
      </CardHead>

      <div className="collab-row collab-local">
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
        <Notice tone="ask" compact role="note">
          {text.needLocal}
        </Notice>
      ) : !localProject.isRepo ? (
        <Notice tone="ask" compact role="note">
          {fill(text.localNotRepo, { project: localProject.name })}
        </Notice>
      ) : null}
      {!canPull ? (
        <Notice tone="info" compact role="note">
          {text.noPull}
        </Notice>
      ) : null}
      {localProject ? mergeNotice(localProject) : null}

      {error ? (
        <Notice
          tone="fail"
          compact
          action={
            <Button size="sm" onPress={() => void load()}>
              {text.retry}
            </Button>
          }
        >
          {fill(text.projectFailed, { error })}
        </Notice>
      ) : null}

      <section className="collab-block" aria-label={`${remoteTag} · ${text.branchesTitle}`}>
        <p className="collab-label">{text.branchesTitle}</p>
        {!view && loading ? (
          <Loading label={text.projectLoading} />
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
                    <MiddleTruncate value={label} className="collab-branch__name collab-code" />
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
                      onPress={() => {
                        if (localProject) onMerge({ project: localProject, ref: branch.trackingRef, source: label })
                      }}
                      data-testid="v3-collab-merge"
                    >
                      {text.merge}
                    </Button>
                    <TooltipTrigger>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Play size={14} aria-hidden />}
                        isPending={busy.has(`continue:${branch.name}`)}
                        isDisabled={!usable || !fetchedHere}
                        onPress={() => continueBranch(branch)}
                        data-testid="v3-collab-continue"
                      >
                        {text.continue}
                      </Button>
                      <Tooltip>{text.continueHint}</Tooltip>
                    </TooltipTrigger>
                  </div>
                  {usable && !fetchedHere ? (
                    <Notice tone="info" variant="hint" role="note">
                      {text.needFetch}
                    </Notice>
                  ) : null}
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

      <section className="collab-block" aria-label={fill(text.pushTitle, { computer: peer.computer })} data-testid="v3-collab-push">
        <p className="collab-label">{fill(text.pushTitle, { computer: peer.computer })}</p>
        <p className="collab-hint">{text.pushHint}</p>
        {!canPush ? (
          <Notice tone="info" compact role="note">
            {text.noPush}
          </Notice>
        ) : null}
        <div className="collab-row">
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
          <span className="collab-row__check">
            <Checkbox isSelected={withRequest} isDisabled={!usable || !canPush} onChange={setWithRequest} data-testid="v3-collab-push-request">
              {text.pushRequest}
            </Checkbox>
          </span>
        </div>
        {withRequest ? (
          <div className="collab-stack">
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
    </Card>
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
  const showCompare = incoming && open && comparing && usable && !!localProject

  useEffect(() => {
    if (!open) setComparing(false)
  }, [open])

  return (
    <Card as="li" quiet={!open} className="collab-card" data-testid={`v3-collab-request-${request.id}`} data-status={request.status}>
      <CardHead className="collab-card__head">
        <CardTitle className="collab-card__title">{request.title || source}</CardTitle>
        <Badge tone={statusTone}>{text.requestStatus[request.status]}</Badge>
      </CardHead>
      <p className="collab-hint collab-request__meta">
        <span>{fill(incoming ? text.requestFrom : text.requestTo, { peer: peerName })}</span>
        <span>· {request.projectName}</span>
        <span>· {source}</span>
        {incoming && localProject ? (
          <span>
            → {text.local} · {localProject.name}
          </span>
        ) : null}
        <span>· {formatCollabTime(request.createdAt, lang)}</span>
      </p>
      {request.note ? <p className="collab-request__note">{request.note}</p> : null}
      {incoming && open && !localProject ? <Notice tone="ask" compact role="note">{text.requestNoLocal}</Notice> : null}
      {incoming && open ? (
        <div className="collab-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<GitCompare size={14} aria-hidden />}
            isDisabled={!usable}
            aria-expanded={showCompare}
            onPress={() => setComparing((value) => !value)}
            data-testid="v3-collab-request-compare"
          >
            {showCompare ? text.compareHide : text.compare}
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
      {showCompare && localProject ? (
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
    </Card>
  )
}

export function CollabPage(): ReactElement {
  const { lang } = useI18n()
  const text = collabText(lang)
  const bridge = useMemo(() => collabBridge(), [])
  const peerBridge = useMemo<CollabPeerBridge | null>(() => collabPeerBridge(), [])
  const [overview, setOverview] = useState<CollabOverview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [records, setRecords] = useState<Record<string, MergeRecord>>({})
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [panelLocals, setPanelLocals] = useState<Record<string, string | null>>({})
  const remoteState = useRemoteStatus()
  const notify = useCallback<Notify>(
    (tone, value) => {
      if (tone === 'info') {
        showToast(value, { tone: 'info' })
        return
      }
      const { summary, folded } = splitMessage(value)
      showToast(summary, {
        tone: 'danger',
        timeout: FAIL_TOAST_MS,
        ...(folded ? { action: { label: text.errorDetails, onAction: () => setErrorDetail(value) } } : {})
      })
    },
    [text]
  )
  const [busy, run] = useBusy((error) => notify('fail', describe(error)))
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
        notify('fail', fill(text.sessionFailed, { error: created.error ?? '' }))
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
        notify('fail', fill(text.mergeConflicts, { project: target.project.name }))
        return
      }
      notify('fail', result.code === 'git-identity-missing' ? text.mergeIdentityMissing : fill(text.mergeFailed, { error: result.error }))
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
        notify('fail', fill(text.continueFailed, { error: result.error }))
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
            notify('fail', fill(text.abortFailed, { error: result.error }))
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
        notify('fail', fill(text.pairFailed, { error: result.error }))
      }
      await refresh()
    })
    return ok
  }

  const connect = (peer: CollabPeerView, ops: PeerOperation[], note: string): void => {
    if (!peerBridge) return
    if (!ops.length) {
      notify('fail', text.needOps)
      return
    }
    void run(`connect:${peer.id}`, async () => {
      const pending = peerBridge.connect(peer.id, ops, note)
      void refresh()
      const result = await pending
      if (result.ok) notify('info', fill(text.connected, { computer: peer.computer }))
      else notify('fail', fill(text.connectFailed, { computer: peer.computer, error: result.error }))
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
        else notify('fail', fill(text.removeFailed, { computer: peer.computer }))
        await refresh()
      }
    })
  }

  const closeRequest = (request: CollabMergeRequest): void => {
    if (!bridge) return
    void run(`close:${request.id}`, async () => {
      const result = await bridge.closeRequest(request.id)
      if (result.ok) notify('info', fill(text.closed, { title: request.title || request.branch }))
      else notify('fail', fill(text.closeFailed, { error: result.error }))
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
      notify('fail', describe(error))
    } finally {
      setConfirmBusy(false)
      setConfirm(null)
    }
  }

  const head = (
    <PageHeader
      description={<span data-testid="v3-collab-lede">{text.lede}</span>}
      title={
        <span className="collab-title">
          <Users size={18} aria-hidden /> {text.title}
        </span>
      }
      actions={
        bridge ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} onPress={() => void refreshAll()} data-testid="v3-collab-refresh">
            {text.refresh}
          </Button>
        ) : null
      }
    />
  )

  if (!bridge) {
    return (
      <div className="collab-page" data-testid="v3-collab-page" data-wired="0">
        {head}
        <Notice tone="ask" role="note" data-testid="v3-collab-missing">
          {text.bridgeMissing}
        </Notice>
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
      <ul className="collab-list">
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
      {loadError ? (
        <Notice
          tone="fail"
          action={
            <Button size="sm" onPress={() => void refreshAll()}>
              {text.retry}
            </Button>
          }
        >
          {fill(text.loadFailed, { error: loadError })}
        </Notice>
      ) : null}
      {!overview && !loadError ? <Loading label={text.loading} /> : null}

      {looseMerges.length ? (
        <section className="collab-section" aria-label={text.local} data-testid="v3-collab-local-merges">
          {looseMerges.map((item) => mergeNotice(item))}
        </section>
      ) : null}

      <SettingSection plain className="collab-section" title={text.peersTitle} description={text.peersHint} aria-label={text.peersTitle} data-testid="v3-collab-peers">
        <div className="collab-section__body">
          {!peerBridge ? (
            <Notice tone="ask" compact role="note">
              {text.peerMissing}
            </Notice>
          ) : null}
          {overview && peers.length === 0 ? <EmptyState size="sm" align="start" title={text.peersEmpty} /> : null}
          {peers.length ? (
            <ul className="collab-list">
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
          <InviteCard text={text} remoteState={remoteState} />
          <PairForm text={text} disabled={!peerBridge} pending={busy.has('pair')} notify={notify} onPair={pair} />
        </div>
      </SettingSection>

      <SettingSection plain className="collab-section" title={text.hostTitle} description={text.hostHint} aria-label={text.hostTitle} data-testid="v3-collab-host">
        <div className="collab-section__body">
          <HostGrants text={text} lang={lang} remoteState={remoteState} notify={notify} />
        </div>
      </SettingSection>

      <SettingSection plain className="collab-section" title={text.projectsTitle} aria-label={text.projectsTitle} data-testid="v3-collab-remote">
        <div className="collab-section__body">
          {connectedPeers.length === 0 ? (
            <EmptyState size="sm" align="start" title={text.projectsEmpty} />
          ) : (
            connectedPeers.map(({ peer, grant }) => (
              <div className="collab-stack" key={peer.id} data-testid={`v3-collab-remote-${peer.id}`}>
                <h4 className="collab-label">{fill(text.remote, { computer: peer.computer })}</h4>
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
        </div>
      </SettingSection>

      <SettingSection plain className="collab-section" title={text.requestsTitle} aria-label={text.requestsTitle} data-testid="v3-collab-requests">
        <div className="collab-section__body">
          <div className="collab-stack" data-testid="v3-collab-requests-incoming">
            <h4 className="collab-label">{text.incoming}</h4>
            {requestList(incomingRequests, text.requestsEmptyIn)}
          </div>
          <div className="collab-stack" data-testid="v3-collab-requests-outgoing">
            <h4 className="collab-label">{text.outgoing}</h4>
            {requestList(outgoingRequests, text.requestsEmptyOut)}
          </div>
        </div>
      </SettingSection>

      <ModalOverlay
        isDismissable={!confirmBusy}
        isOpen={!!confirm}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirm(null)
        }}
      >
        <Modal data-dialog-size="sm">
          <Dialog title={confirm?.title} closeLabel={text.cancel} data-testid="v3-collab-confirm">
            <p className="collab-confirm__body">{confirm?.body}</p>
            {confirm?.hint ? <p className="collab-hint">{confirm.hint}</p> : null}
            <DialogFooter>
              <Button variant="ghost" isDisabled={confirmBusy} onPress={() => setConfirm(null)}>
                {text.cancel}
              </Button>
              <Button
                variant={confirm?.danger ? 'destructive' : 'primary'}
                isPending={confirmBusy}
                onPress={() => void confirmRun()}
                data-testid="v3-collab-confirm-ok"
              >
                {confirm?.confirmLabel}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay isDismissable isOpen={errorDetail !== null} onOpenChange={(open) => (open ? undefined : setErrorDetail(null))}>
        <Modal data-dialog-size="md">
          <Dialog title={text.errorDetailTitle} closeLabel={text.close} data-testid="v3-collab-error-detail">
            <pre className="collab-error-detail collab-code" tabIndex={0}>
              {errorDetail}
            </pre>
            <DialogFooter>
              <Button variant="primary" onPress={() => setErrorDetail(null)}>
                {text.close}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  )
}
