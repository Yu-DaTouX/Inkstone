import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  COLLAB_REQUEST_NOTE_MAX,
  shortRef,
  slugForRemote,
  trackingRefFor,
  type CollabBridge,
  type CollabComparison,
  type CollabContinueResult,
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
  createWorktree(input: { cwd: string; branch: string; startPoint: string }): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }>
  notifyIncoming?(request: CollabMergeRequest): void
  now?: () => number
}

const MAX_REQUESTS = 200
const MAX_FETCHED = 500
const MAX_SESSION_IMPORTS = 500
const MAX_BRANCH_SESSIONS = 5
const PEER_BASE = '/remote/v1/peer/collab'

function emptyState(): CollabStateFile {
  return { version: 1, links: [], requests: [], fetched: [], sessionImports: [] }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export class CollabService implements CollabBridge {
  private state: CollabStateFile | null = null
  private loading: Promise<CollabStateFile> | null = null
  private writing: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: CollabServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private load(): Promise<CollabStateFile> {
    if (this.state) return Promise.resolve(this.state)
    this.loading ??= this.readState()
    return this.loading
  }

  private async readState(): Promise<CollabStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.deps.stateFile, 'utf8')) as Partial<CollabStateFile>
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

  private async localRoot(localProjectId: string): Promise<{ id: string; name: string; root: string } | { error: string }> {
    const project = (await this.deps.localProjects()).find((item) => item.id === localProjectId)
    if (!project) return { error: '找不到本地项目' }
    const root = await repoRootOf(project.cwd)
    if (!root) return { error: `本地项目「${project.name}」不是 Git 仓库` }
    return { id: project.id, name: project.name, root }
  }

  private async linkedRoot(peerId: string, remoteProjectId: string): Promise<{ id: string; name: string; root: string } | { error: string }> {
    const link = (await this.load()).links.find((item) => item.peerId === peerId && item.remoteProjectId === remoteProjectId)
    if (!link) return { error: '先选择对应的本地项目' }
    return this.localRoot(link.localProjectId)
  }

  private async listing(peerId: string, remoteProjectId: string): Promise<Result<CollabProjectListing>> {
    return this.deps.transport.call<CollabProjectListing>(peerId, `${PEER_BASE}/projects/${encodeURIComponent(remoteProjectId)}/branches`)
  }

  async overview(): Promise<CollabOverview> {
    const status = await this.deps.peerStatus()
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
    if (!peer) return { ok: false, error: '找不到这台砚' }
    if (!peer.grant) return { ok: false, error: '还没有连接这台砚，先申请连接' }
    const project = peer.grant.projects.find((item) => item.id === remoteProjectId)
    if (!project) return { ok: false, error: '对方没有向本次连接开放这个项目' }
    const listed = await this.listing(peerId, remoteProjectId)
    if (!listed.ok) return listed
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
      return { ok: false, error: '找不到本地项目' }
    }
    const state = await this.update((draft) => {
      draft.links = draft.links.filter((item) => !(item.peerId === peerId && item.remoteProjectId === remoteProjectId))
      if (localProjectId) draft.links.push({ peerId, remoteProjectId, localProjectId })
    })
    return { ok: true, data: [...state.links] }
  }

  async fetch(peerId: string, remoteProjectId: string, branch: string): Promise<CollabResult<CollabFetchResult>> {
    const invalid = checkBranchName(branch)
    if (invalid) return { ok: false, error: invalid }
    const peer = await this.peerOf(peerId)
    if (!peer) return { ok: false, error: '找不到这台砚' }
    const local = await this.linkedRoot(peerId, remoteProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const listed = await this.listing(peerId, remoteProjectId)
    if (!listed.ok) return listed
    const remoteBranch = listed.data.branches.find((item) => item.name === branch)
    if (!remoteBranch) return { ok: false, error: `对方没有分支 ${branch}` }
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
      if (!downloaded.ok) return downloaded
      if (downloaded.data.kind === 'json') {
        const known = downloaded.data.data?.oid
        if (!isOid(known)) return { ok: false, error: '对方返回的提交号无效' }
        const pointed = await pointTrackingRef(local.root, trackingRef, known)
        if (!pointed.ok) return pointed
        oid = known
        upToDate = true
      } else {
        const head = await bundleHead(local.root, file, branch)
        if (!head) return { ok: false, error: '代码包里没有这个分支' }
        const fetched = await fetchBundle(local.root, file, branch, trackingRef, head)
        if (!fetched.ok) return fetched
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
        importErrors.push(`${session.title || session.sessionId}：${result.error}`)
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
    if ('error' in local) return { ok: false, error: local.error }
    const result = await compareWith(local.root, ref)
    return 'error' in result ? { ok: false, error: result.error } : { ok: true, data: result }
  }

  async fileDiff(localProjectId: string, ref: string, path: string): Promise<CollabResult<string>> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const result = await fileDiffWith(local.root, ref, path)
    return typeof result === 'string' ? { ok: true, data: result } : { ok: false, error: result.error }
  }

  async merge(localProjectId: string, ref: string, requestId?: string): Promise<CollabMergeResult> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const result = await mergeRef(local.root, ref, `合并 ${shortRef(ref)}（多人协作）`)
    if (result.ok && requestId) {
      await this.update((draft) => {
        const request = draft.requests.find((item) => item.id === requestId && item.direction === 'incoming')
        if (request) request.status = 'merged'
      })
    }
    return result
  }

  async abortMerge(localProjectId: string): Promise<CollabResult<true>> {
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const result = await abortMerge(local.root)
    return result.ok ? { ok: true, data: true } : result
  }

  async push(input: CollabPushInput): Promise<CollabResult<{ trackingRef: string; requestId: string | null }>> {
    const invalid = checkBranchName(input.branch)
    if (invalid) return { ok: false, error: invalid }
    const peer = await this.peerOf(input.peerId)
    if (!peer) return { ok: false, error: '找不到这台砚' }
    if (!peer.grant?.operations.includes('push')) return { ok: false, error: '本次连接没有推送权限，需要重新申请连接并勾选「推送」' }
    const local = await this.localRoot(input.localProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const oid = await resolveCommit(local.root, `refs/heads/${input.branch}`)
    if (!oid) return { ok: false, error: `本地没有分支 ${input.branch}` }
    const listed = await this.listing(input.peerId, input.remoteProjectId)
    if (!listed.ok) return listed
    await this.link(input.peerId, input.remoteProjectId, input.localProjectId)
    await mkdir(this.deps.tempDir, { recursive: true })
    const file = bundleTempPath(this.deps.tempDir, 'push')
    let pushed: Result<{ trackingRef: string; oid: string }>
    try {
      const outcome = await createBundle(local.root, input.branch, listed.data.tips, file)
      if (outcome.kind === 'error') return { ok: false, error: outcome.error }
      const query = new URLSearchParams({ branch: input.branch, oid: outcome.oid, ...(outcome.kind === 'up-to-date' ? { known: '1' } : {}) })
      pushed = await this.deps.transport.upload<{ trackingRef: string; oid: string }>(
        input.peerId,
        `${PEER_BASE}/projects/${encodeURIComponent(input.remoteProjectId)}/push?${query}`,
        outcome.kind === 'bundle' ? file : null
      )
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }
    if (!pushed.ok) return pushed
    let requestId: string | null = null
    if (input.request) {
      const title = input.request.title.trim().slice(0, 200) || input.branch
      const note = input.request.note.trim().slice(0, COLLAB_REQUEST_NOTE_MAX)
      const opened = await this.deps.transport.call<{ requestId: string }>(
        input.peerId,
        `${PEER_BASE}/projects/${encodeURIComponent(input.remoteProjectId)}/requests`,
        { method: 'POST', body: { branch: input.branch, oid, title, note } }
      )
      if (!opened.ok) return { ok: false, error: `分支已推送，但合并请求没有发出：${opened.error}` }
      requestId = opened.data.requestId
      const remoteProject = peer.grant.projects.find((item) => item.id === input.remoteProjectId)
      await this.update((draft) => {
        draft.requests.push({
          id: requestId!,
          direction: 'outgoing',
          peerName: peer.computer,
          peerId: input.peerId,
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
      draft.requests = draft.requests.filter((item) => !(item.direction === 'incoming' && item.status === 'open' && item.trackingRef === request.trackingRef && item.localProjectId === request.localProjectId))
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
    return found ? { ok: true, data: true } : { ok: false, error: '找不到这条合并请求，或它已处理' }
  }

  async continueFrom(localProjectId: string, ref: string, importId?: string): Promise<CollabResult<CollabContinueResult>> {
    const invalid = checkTrackingRef(ref)
    if (invalid) return { ok: false, error: invalid }
    const local = await this.localRoot(localProjectId)
    if ('error' in local) return { ok: false, error: local.error }
    const oid = await resolveCommit(local.root, ref)
    if (!oid) return { ok: false, error: '还没有拉取这个分支' }
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
    if (!created.ok) return created
    const state = await this.load()
    const peerIds = new Set(status.peers.filter((peer) => slugForRemote(peer.computer, peer.id) === remoteName).map((peer) => peer.id))
    const chosen = importId
      ? state.sessionImports.find((item) => item.importId === importId)
      : [...state.sessionImports].reverse().find((item) => item.branch === remoteBranch && peerIds.has(item.peerId))
    const dir = chosen ? await this.deps.readImportDir(chosen.importId) : null
    const lines = [
      `接着 ${computer} 在分支 ${remoteBranch} 上的工作继续。`,
      `代码在新工作树 ${created.path} 的分支 ${created.branch}，起点是对方的 ${short}（${oid.slice(0, 7)}）。`
    ]
    if (chosen && dir) lines.push(`对方会话《${chosen.title}》的只读副本在 ${join(dir, 'messages.json')}，先读它了解对方做到哪里、还剩什么，再继续。`)
    return { ok: true, data: { worktree: created.path, branch: created.branch, prompt: lines.join('\n') } }
  }
}
