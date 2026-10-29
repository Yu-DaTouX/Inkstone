import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  COLLAB_REQUEST_NOTE_MAX,
  isCollabFailureCode,
  shortRef,
  slugForRemote,
  trackingRefFor,
  type CollabBridge,
  type CollabComparison,
  type CollabContinueResult,
  type CollabFailure,
  type CollabFailureCode,
  type CollabFetchRecord,
  type CollabFetchResult,
  type CollabLink,
  type CollabLocalProject,
  type CollabMergeRequest,
  type CollabMergeResult,
  type CollabOverview,
  type CollabProjectListing,
  type CollabPushInput,
  type CollabRemoteProjectView,
  type CollabRequestState,
  type CollabResult
} from '../../shared/collab'
import type { PeerGrantView, PeerImportView, PeerStatusView } from '../../shared/peer-protocol'
import type { PeerTransport, Result } from '../peer-client'
import {
  abortMerge,
  aheadBehind,
  bundleHead,
  bundleTempPath,
  checkBranchName,
  checkTrackingRef,
  compareWith,
  createBundle,
  currentBranch,
  fetchBundle,
  fileDiffWith,
  isOid,
  localBranches,
  mergeInProgress,
  mergeRef,
  pointTrackingRef,
  refTips,
  repoRootOf,
  resolveCommit,
  rootCommits
} from './git'

interface SessionImportRecord {
  peerId: string
  sessionId: string
  updatedAt: number
  importId: string
  title: string
  branch: string
}

interface CollabStateFile {
  version: 1
  links: CollabLink[]
  requests: CollabMergeRequest[]
  fetched: CollabFetchRecord[]
  sessionImports: SessionImportRecord[]
}

export interface CollabServiceDeps {
  stateFile: string
  tempDir: string
  transport: PeerTransport
  peerStatus(): Promise<PeerStatusView>
  localProjects(): Promise<Array<{ id: string; name: string; cwd: string }>>
  importSession(peerId: string, sessionId: string): Promise<Result<PeerImportView>>
  readImportDir(importId: string): Promise<string | null>
  createWorktree(input: { cwd: string; branch: string; startPoint: string }): Promise<({ ok: true; path: string; branch: string } | ({ ok: false } & Partial<CollabFailure>))>
  notifyIncoming?(request: CollabMergeRequest): void
  now?: () => number
}

const MAX_REQUESTS = 200
const MAX_FETCHED = 500
const MAX_SESSION_IMPORTS = 500
const MAX_BRANCH_SESSIONS = 5
const RECONCILE_BATCH_SIZE = 4
const RECONCILE_BATCH_INTERVAL_MS = 5000
const RECONCILE_REQUEST_INTERVAL_MS = 30_000
const PEER_BASE = '/remote/v1/peer/collab'

function emptyState(): CollabStateFile {
  return { version: 1, links: [], requests: [], fetched: [], sessionImports: [] }
}

function failure(code: CollabFailureCode, error: string): { ok: false; error: string; code: CollabFailureCode } {
  return { ok: false, error, code }
}

function passFailure(result: { error: string; code?: string }): { ok: false; error: string; code?: CollabFailureCode } {
  const code = result.code
  return { ok: false, error: result.error, ...(code && isCollabFailureCode(code) ? { code } : {}) }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function requestKey(request: CollabMergeRequest): string {
  return JSON.stringify([request.id, request.peerId, request.remoteProjectId, request.localProjectId, request.branch, request.oid])
}

export class CollabService implements CollabBridge {
  private state: CollabStateFile | null = null
  private loading: Promise<CollabStateFile> | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private reconciling: Promise<void> | null = null
  private nextReconcileAt = 0
  private readonly requestChecks = new Map<string, number>()

  constructor(private readonly deps: CollabServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private load(): Promise<CollabStateFile> {
    if (this.state) return Promise.resolve(this.state)
    this.loading ??= this.readState().finally(() => { this.loading = null })
    return this.loading
  }

  private async readState(): Promise<CollabStateFile> {
    let text: string
    try {
      text = await readFile(this.deps.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      this.state = emptyState()
      return this.state
    }
    try {
      const raw = JSON.parse(text) as Partial<CollabStateFile>
      if (raw?.version !== 1) throw new SyntaxError('unsupported collab state')
      this.state = raw?.version === 1
        ? {
            version: 1,
            links: asArray<CollabLink>(raw.links),
            requests: asArray<CollabMergeRequest>(raw.requests),
            fetched: asArray<CollabFetchRecord>(raw.fetched),
            sessionImports: asArray<SessionImportRecord>(raw.sessionImports)
          }
        : emptyState()
    } catch {
      await copyFile(this.deps.stateFile, `${this.deps.stateFile}.corrupt-${Date.now()}`)
      this.state = emptyState()
    }
    return this.state
  }

  private async update(mutate: (state: CollabStateFile) => void): Promise<CollabStateFile> {
    const run = async (): Promise<CollabStateFile> => {
      const state = await this.load()
      mutate(state)
      state.requests = state.requests.slice(-MAX_REQUESTS)
      state.fetched = state.fetched.slice(-MAX_FETCHED)
      state.sessionImports = state.sessionImports.slice(-MAX_SESSION_IMPORTS)
      await mkdir(dirname(this.deps.stateFile), { recursive: true })
      const temp = `${this.deps.stateFile}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
      await rename(temp, this.deps.stateFile)
      return state
    }
    const next = this.writing.then(run, run)
    this.writing = next.catch(() => undefined)
    return next
  }

  private async peerOf(peerId: string): Promise<{ computer: string; remoteName: string; grant: PeerGrantView | null } | null> {
    const peer = (await this.deps.peerStatus()).peers.find((item) => item.id === peerId)
    if (!peer) return null
    return {
      computer: peer.computer,
      remoteName: slugForRemote(peer.computer, peer.id),
      grant: peer.connection.state === 'connected' ? peer.connection.grant : null
    }
  }

  private async localRoot(localProjectId: string): Promise<{ id: string; name: string; root: string } | CollabFailure> {
    const project = (await this.deps.localProjects()).find((item) => item.id === localProjectId)
    if (!project) return { code: 'local-project-missing', error: 'That local project could not be found' }
    const root = await repoRootOf(project.cwd)
    if (!root) return { code: 'local-project-not-repo', error: 'That local project is not a Git repository' }
    return { id: project.id, name: project.name, root }
  }

  private async linkedRoot(peerId: string, remoteProjectId: string): Promise<{ id: string; name: string; root: string } | CollabFailure> {
    const link = (await this.load()).links.find((item) => item.peerId === peerId && item.remoteProjectId === remoteProjectId)
    if (!link) return { code: 'local-project-unlinked', error: 'No local project is linked to theirs yet' }
    return this.localRoot(link.localProjectId)
  }

  private async listing(peerId: string, remoteProjectId: string): Promise<Result<CollabProjectListing>> {
    return this.deps.transport.call<CollabProjectListing>(peerId, `${PEER_BASE}/projects/${encodeURIComponent(remoteProjectId)}/branches`)
  }

  private reconcile(status: PeerStatusView): Promise<void> {
    if (this.reconciling) return this.reconciling
    if (this.now() < this.nextReconcileAt) return Promise.resolve()
    const run = async (): Promise<void> => {
      const now = this.now()
      const state = await this.load()
      const keys = new Set(state.requests.map(requestKey))
      for (const key of this.requestChecks.keys()) if (!keys.has(key)) this.requestChecks.delete(key)
      const requests = state.requests.filter((request) => {
        const peer = status.peers.find((item) => item.id === request.peerId)
        return request.direction === 'outgoing' && request.status === 'open' && request.remoteProjectId && peer?.connection.state === 'connected'
          && peer.connection.grant.operations.includes('push') && peer.connection.grant.projects.some((project) => project.id === request.remoteProjectId)
          && now >= (this.requestChecks.get(requestKey(request)) ?? -Infinity) + RECONCILE_REQUEST_INTERVAL_MS
      }).sort((a, b) => (this.requestChecks.get(requestKey(a)) ?? -Infinity) - (this.requestChecks.get(requestKey(b)) ?? -Infinity))
        .slice(0, RECONCILE_BATCH_SIZE).map((request) => ({ ...request }))
      if (!requests.length) return
      this.nextReconcileAt = now + RECONCILE_BATCH_INTERVAL_MS
      for (const request of requests) this.requestChecks.set(requestKey(request), now)
      const outcomes = await Promise.allSettled(requests.map(async (request) => {
        const result = await this.deps.transport.call<CollabRequestState>(request.peerId!, `${PEER_BASE}/projects/${encodeURIComponent(request.remoteProjectId!)}/requests/${encodeURIComponent(request.id)}`, { timeoutMs: 3000 })
        if (!result.ok) return null
        const data = result.data
        return data && data.requestId === request.id && data.projectId === request.remoteProjectId && data.branch === request.branch && data.oid === request.oid
          && (data.status === 'merged' || data.status === 'closed') ? { request, status: data.status } : null
      }))
      const changes = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : [])
      if (changes.length) await this.update((draft) => {
        for (const change of changes) {
          const request = draft.requests.find((item) => item.direction === 'outgoing' && requestKey(item) === requestKey(change.request))
          if (request?.status === 'open') request.status = change.status
        }
      })
    }
    this.reconciling = run().catch(() => undefined).finally(() => { this.reconciling = null })
    return this.reconciling
  }

  async overview(): Promise<CollabOverview> {
    const status = await this.deps.peerStatus()
    await this.reconcile(status)
    const state = await this.load()
    const localProjects: CollabLocalProject[] = []
    for (const project of await this.deps.localProjects()) {
      const root = await repoRootOf(project.cwd)
      localProjects.push({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        isRepo: !!root,
        currentBranch: root ? await currentBranch(root) : null,
        branches: root ? (await localBranches(root)).map((branch) => branch.name) : [],
        mergeInProgress: root ? await mergeInProgress(root) : false
      })
    }
    return {
      peers: status.peers.map((peer) => ({
        id: peer.id,
        computer: peer.computer,
        address: peer.address,
        remoteName: slugForRemote(peer.computer, peer.id),
        connection: peer.connection
      })),
      localProjects,
      links: [...state.links],
      requests: [...state.requests].sort((a, b) => b.createdAt - a.createdAt),
      fetched: [...state.fetched].sort((a, b) => b.fetchedAt - a.fetchedAt)
    }
  }

  async remoteProject(peerId: string, remoteProjectId: string): Promise<CollabResult<CollabRemoteProjectView>> {
    const peer = await this.peerOf(peerId)
    if (!peer) return failure('peer-missing', 'That computer is not paired')
    if (!peer.grant) return failure('peer-not-connected', 'Not connected to that computer yet')
    const project = peer.grant.projects.find((item) => item.id === remoteProjectId)
    if (!project) return failure('peer-project-denied', 'They did not share this project for this connection')
    const listed = await this.listing(peerId, remoteProjectId)
    if (!listed.ok) return passFailure(listed)
    await this.reconcile(await this.deps.peerStatus())
    const listing = listed.data
    const locals = await this.deps.localProjects()
    const link = (await this.load()).links.find((item) => item.peerId === peerId && item.remoteProjectId === remoteProjectId)
    const localProjectId = link && locals.some((item) => item.id === link.localProjectId) ? link.localProjectId : null
    let suggestedLocalProjectId: string | null = null
    const remoteRoots = new Set(listing.rootCommits)
    for (const local of locals) {
      const root = await repoRootOf(local.cwd)
      if (root && (await rootCommits(root)).some((oid) => remoteRoots.has(oid))) {
        suggestedLocalProjectId = local.id
        break
      }
    }
    const root = localProjectId ? await this.localRoot(localProjectId) : null
    const branches: CollabRemoteProjectView['branches'] = []
    for (const branch of listing.branches) {
      const trackingRef = trackingRefFor(peer.remoteName, branch.name)
      const fetchedOid = root && 'root' in root ? await resolveCommit(root.root, trackingRef) : null
      const counts = fetchedOid && root && 'root' in root ? await aheadBehind(root.root, trackingRef) : null
      branches.push({ ...branch, trackingRef, fetchedOid, incoming: counts?.incoming ?? null, outgoing: counts?.outgoing ?? null })
    }
    return { ok: true, data: { peerId, project, grant: peer.grant, localProjectId, suggestedLocalProjectId, branches } }
  }

  async link(peerId: string, remoteProjectId: string, localProjectId: string | null): Promise<CollabResult<CollabLink[]>> {
    if (localProjectId && !(await this.deps.localProjects()).some((item) => item.id === localProjectId)) {
      return failure('local-project-missing', 'That local project could not be found')
    }
    const state = await this.update((draft) => {
      draft.links = draft.links.filter((item) => !(item.peerId === peerId && item.remoteProjectId === remoteProjectId))
      if (localProjectId) draft.links.push({ peerId, remoteProjectId, localProjectId })
    })
    return { ok: true, data: [...state.links] }
  }

  async fetch(peerId: string, remoteProjectId: string, branch: string): Promise<CollabResult<CollabFetchResult>> {
    const invalid = checkBranchName(branch)
    if (invalid) return { ok: false, ...invalid }
    const peer = await this.peerOf(peerId)
    if (!peer) return failure('peer-missing', 'That computer is not paired')
    const local = await this.linkedRoot(peerId, remoteProjectId)
    if ('error' in local) return passFailure(local)
    const listed = await this.listing(peerId, remoteProjectId)
    if (!listed.ok) return passFailure(listed)
    const remoteBranch = listed.data.branches.find((item) => item.name === branch)
    if (!remoteBranch) return failure('peer-branch-missing', 'They do not have that branch')
    const trackingRef = trackingRefFor(peer.remoteName, branch)
    await mkdir(this.deps.tempDir, { recursive: true })
    const file = bundleTempPath(this.deps.tempDir, 'fetch')
    let oid: string
    let upToDate = false
    try {
      const downloaded = await this.deps.transport.download<{ upToDate?: boolean; oid?: string }>(
        peerId,
        `${PEER_BASE}/projects/${encodeURIComponent(remoteProjectId)}/bundle`,
        { branch, haves: await refTips(local.root) },
        file
      )
      if (!downloaded.ok) return passFailure(downloaded)
      if (downloaded.data.kind === 'json') {
        const known = downloaded.data.data?.oid
        if (!isOid(known)) return failure('peer-oid-invalid', 'They returned an invalid commit id')
        const pointed = await pointTrackingRef(local.root, trackingRef, known)
        if (!pointed.ok) return passFailure(pointed)
        oid = known
        upToDate = true
      } else {
        const head = await bundleHead(local.root, file, branch)
        if (!head) return failure('bundle-branch-missing', 'The code bundle does not contain this branch')
        const fetched = await fetchBundle(local.root, file, branch, trackingRef, head)
        if (!fetched.ok) return passFailure(fetched)
        oid = head
      }
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }
    const imported: CollabFetchResult['imported'] = []
    const importErrors: string[] = []
    const previous = (await this.load()).sessionImports
    for (const session of remoteBranch.sessions.slice(0, MAX_BRANCH_SESSIONS)) {
      const done = previous.find((item) => item.peerId === peerId && item.sessionId === session.sessionId && item.updatedAt === session.updatedAt)
      if (done) {
        imported.push({ importId: done.importId, title: done.title })
        continue
      }
      const result = await this.deps.importSession(peerId, session.sessionId)
      if (!result.ok) {
        importErrors.push(`${session.title || session.sessionId}: ${result.error}`)
        continue
      }
      imported.push({ importId: result.data.id, title: result.data.title })
      await this.update((draft) => {
        draft.sessionImports.push({ peerId, sessionId: session.sessionId, updatedAt: session.updatedAt, importId: result.data.id, title: result.data.title, branch })
      })
    }
    const counts = (await aheadBehind(local.root, trackingRef)) ?? { incoming: 0, outgoing: 0 }
    await this.update((draft) => {
      draft.fetched = draft.fetched.filter((item) => !(item.peerId === peerId && item.remoteProjectId === remoteProjectId && item.branch === branch))
      draft.fetched.push({
        peerId,
        remoteProjectId,
        localProjectId: local.id,
        branch,
        trackingRef,
        oid,
        fetchedAt: this.now(),
        importIds: imported.map((item) => item.importId)
      })
    })
    return { ok: true, data: { trackingRef, oid, upToDate, ...counts, imported, importErrors } }
  }

  async compare(localProjectId: string, ref: string): Promise<CollabResult<CollabComparison>> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return passFailure(local)
    const result = await compareWith(local.root, ref)
    return 'error' in result ? passFailure(result) : { ok: true, data: result }
  }

  async fileDiff(localProjectId: string, ref: string, path: string): Promise<CollabResult<string>> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return passFailure(local)
    const result = await fileDiffWith(local.root, ref, path)
    return typeof result === 'string' ? { ok: true, data: result } : passFailure(result)
  }

  async merge(localProjectId: string, ref: string, requestId?: string): Promise<CollabMergeResult> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return passFailure(local)
    if (requestId) {
      const request = (await this.load()).requests.find((item) => item.id === requestId && item.direction === 'incoming')
      if (!request || request.status !== 'open' || request.localProjectId !== localProjectId || request.trackingRef !== ref || request.oid !== await resolveCommit(local.root, ref)) {
        return failure('request-mismatch', 'The merge request no longer matches this project, branch or commit')
      }
    }
    const result = await mergeRef(local.root, ref, `Merge ${shortRef(ref)}`)
    if (result.ok && requestId) {
      try {
        await this.update((draft) => {
          const request = draft.requests.find((item) => item.id === requestId && item.direction === 'incoming' && item.status === 'open')
          if (request) request.status = 'merged'
        })
      } catch {
        return { ...result, message: `${result.message}\nGit merge succeeded, but the merge request state could not be saved; refresh to check.` }
      }
    }
    return result
  }

  async abortMerge(localProjectId: string): Promise<CollabResult<true>> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return passFailure(local)
    const result = await abortMerge(local.root)
    return result.ok ? { ok: true, data: true } : passFailure(result)
  }

  async push(input: CollabPushInput): Promise<CollabResult<{ trackingRef: string; requestId: string | null }>> {
    const invalid = checkBranchName(input.branch)
    if (invalid) return { ok: false, ...invalid }
    const peer = await this.peerOf(input.peerId)
    if (!peer) return failure('peer-missing', 'That computer is not paired')
    if (!peer.grant?.operations.includes('push')) {
      return failure('push-denied', 'This connection does not allow pushing')
    }
    const local = await this.localRoot(input.localProjectId)
    if ('error' in local) return passFailure(local)
    const oid = await resolveCommit(local.root, `refs/heads/${input.branch}`)
    if (!oid) return failure('local-branch-missing', 'This computer does not have that branch')
    const listed = await this.listing(input.peerId, input.remoteProjectId)
    if (!listed.ok) return passFailure(listed)
    await this.link(input.peerId, input.remoteProjectId, input.localProjectId)
    await mkdir(this.deps.tempDir, { recursive: true })
    const file = bundleTempPath(this.deps.tempDir, 'push')
    let pushed: Result<{ trackingRef: string; oid: string }>
    try {
      const outcome = await createBundle(local.root, input.branch, listed.data.tips, file)
      if (outcome.kind === 'error') return { ok: false, error: outcome.error, code: outcome.code }
      const query = new URLSearchParams({ branch: input.branch, oid: outcome.oid, ...(outcome.kind === 'up-to-date' ? { known: '1' } : {}) })
      pushed = await this.deps.transport.upload<{ trackingRef: string; oid: string }>(
        input.peerId,
        `${PEER_BASE}/projects/${encodeURIComponent(input.remoteProjectId)}/push?${query}`,
        outcome.kind === 'bundle' ? file : null
      )
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }
    if (!pushed.ok) return passFailure(pushed)
    let requestId: string | null = null
    if (input.request) {
      const title = input.request.title.trim().slice(0, 200) || input.branch
      const note = input.request.note.trim().slice(0, COLLAB_REQUEST_NOTE_MAX)
      const opened = await this.deps.transport.call<{ requestId: string }>(
        input.peerId,
        `${PEER_BASE}/projects/${encodeURIComponent(input.remoteProjectId)}/requests`,
        { method: 'POST', body: { branch: input.branch, oid, title, note } }
      )
      if (!opened.ok) {
        return { ok: false, error: 'The branch was pushed, but the merge request was not sent', code: 'request-open-failed' }
      }
      requestId = opened.data.requestId
      const remoteProject = peer.grant.projects.find((item) => item.id === input.remoteProjectId)
      await this.update((draft) => {
        draft.requests.push({
          id: requestId!,
          direction: 'outgoing',
          peerName: peer.computer,
          peerId: input.peerId,
          remoteProjectId: input.remoteProjectId,
          localProjectId: input.localProjectId,
          projectName: remoteProject?.name ?? local.name,
          branch: input.branch,
          trackingRef: pushed.ok ? pushed.data.trackingRef : '',
          oid,
          title,
          note,
          createdAt: this.now(),
          status: 'open'
        })
      })
    }
    return { ok: true, data: { trackingRef: pushed.data.trackingRef, requestId } }
  }

  async receiveRequest(request: CollabMergeRequest): Promise<void> {
    await this.update((draft) => {
      for (const item of draft.requests) {
        if (item.direction === 'incoming' && item.status === 'open' && item.peerDeviceId === request.peerDeviceId && item.trackingRef === request.trackingRef && item.localProjectId === request.localProjectId) item.status = 'closed'
      }
      draft.requests.push(request)
    })
    try {
      this.deps.notifyIncoming?.(request)
    } catch {
    }
  }

  async closeRequest(requestId: string): Promise<CollabResult<true>> {
    let found = false
    await this.update((draft) => {
      const request = draft.requests.find((item) => item.id === requestId)
      if (request && request.status === 'open') {
        request.status = 'closed'
        found = true
      }
    })
    return found ? { ok: true, data: true } : failure('request-missing', 'That merge request is missing or already handled')
  }

  async continueFrom(localProjectId: string, ref: string, importId?: string): Promise<CollabResult<CollabContinueResult>> {
    const invalid = checkTrackingRef(ref)
    if (invalid) return { ok: false, ...invalid }
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return passFailure(local)
    const oid = await resolveCommit(local.root, ref)
    if (!oid) return failure('branch-not-fetched', 'This branch has not been pulled yet')
    const short = shortRef(ref)
    const slash = short.indexOf('/')
    const remoteName = short.slice(0, slash)
    const remoteBranch = short.slice(slash + 1)
    const status = await this.deps.peerStatus()
    const computer = status.peers.find((peer) => slugForRemote(peer.computer, peer.id) === remoteName)?.computer
      ?? (await this.load()).requests.find((item) => item.trackingRef === ref)?.peerName
      ?? remoteName
    const owner = remoteName.replace(/^yan-/, '') || 'peer'
    const base = /^[\x21-\x7e]+$/.test(remoteBranch) ? `${owner}/${remoteBranch}` : `${owner}/branch-${oid.slice(0, 7)}`
    let branch = base
    for (let index = 2; (await resolveCommit(local.root, `refs/heads/${branch}`)) && index < 50; index++) branch = `${base}-${index}`
    const created = await this.deps.createWorktree({ cwd: local.root, branch, startPoint: oid })
    if (!created.ok) {
      return { ok: false, error: created.error ?? 'Could not create the worktree', code: created.code ?? 'worktree-create-failed' }
    }
    const state = await this.load()
    const peerIds = new Set(status.peers.filter((peer) => slugForRemote(peer.computer, peer.id) === remoteName).map((peer) => peer.id))
    const chosen = importId
      ? state.sessionImports.find((item) => item.importId === importId)
      : [...state.sessionImports].reverse().find((item) => item.branch === remoteBranch && peerIds.has(item.peerId))
    const dir = chosen ? await this.deps.readImportDir(chosen.importId) : null
    const lines = [
      `Continue the work ${computer} did on branch ${remoteBranch}.`,
      `The code is in the new worktree ${created.path} on branch ${created.branch}, starting at their ${short} (${oid.slice(0, 7)}).`
    ]
    if (chosen && dir) {
      lines.push(
        `A read-only copy of their session "${chosen.title}" is at ${join(dir, 'messages.json')}: read it first to see where they left off and what is left to do.`
      )
    }
    return { ok: true, data: { worktree: created.path, branch: created.branch, prompt: lines.join('\n') } }
  }
}
