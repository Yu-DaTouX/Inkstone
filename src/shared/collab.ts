import type { PeerConnectionState, PeerGrantView, PeerProjectRef } from './peer-protocol'

export const COLLAB_BUNDLE_MAX_BYTES = 512 * 1024 * 1024
export const COLLAB_REMOTE_PREFIX = 'yan-'
export const COLLAB_MAX_HAVES = 200
export const COLLAB_MAX_BRANCHES = 200
export const COLLAB_REQUEST_NOTE_MAX = 2000

export interface CollabBranchSession {
  sessionId: string
  title: string
  updatedAt: number
  messageCount: number
}

export interface CollabBranch {
  name: string
  oid: string
  subject: string
  author: string
  committedAt: number
  current: boolean
  sessions: CollabBranchSession[]
}

export interface CollabProjectListing {
  projectId: string
  projectName: string
  rootCommits: string[]
  tips: string[]
  branches: CollabBranch[]
}

export interface CollabLocalProject {
  id: string
  name: string
  cwd: string
  isRepo: boolean
  currentBranch: string | null
  branches: string[]
  mergeInProgress: boolean
}

export interface CollabPeerView {
  id: string
  computer: string
  address: string
  remoteName: string
  connection: PeerConnectionState
}

export type CollabRequestDirection = 'incoming' | 'outgoing'
export type CollabRequestStatus = 'open' | 'merged' | 'closed'

export interface CollabMergeRequest {
  id: string
  direction: CollabRequestDirection
  peerName: string
  peerId?: string
  peerDeviceId?: string
  remoteProjectId?: string
  localProjectId: string
  projectName: string
  branch: string
  trackingRef: string
  oid: string
  title: string
  note: string
  createdAt: number
  status: CollabRequestStatus
}

export interface CollabRequestState {
  requestId: string
  projectId: string
  branch: string
  oid: string
  status: CollabRequestStatus
}

export interface CollabFetchRecord {
  peerId: string
  remoteProjectId: string
  localProjectId: string
  branch: string
  trackingRef: string
  oid: string
  fetchedAt: number
  importIds: string[]
}

export interface CollabLink {
  peerId: string
  remoteProjectId: string
  localProjectId: string
}

export interface CollabOverview {
  peers: CollabPeerView[]
  localProjects: CollabLocalProject[]
  links: CollabLink[]
  requests: CollabMergeRequest[]
  fetched: CollabFetchRecord[]
}

export interface CollabRemoteBranchView extends CollabBranch {
  trackingRef: string
  fetchedOid: string | null
  incoming: number | null
  outgoing: number | null
}

export interface CollabRemoteProjectView {
  peerId: string
  project: PeerProjectRef
  grant: PeerGrantView
  localProjectId: string | null
  suggestedLocalProjectId: string | null
  branches: CollabRemoteBranchView[]
}

export interface CollabCommit {
  oid: string
  subject: string
  author: string
  committedAt: number
}

export interface CollabFileChange {
  path: string
  status: string
  additions: number | null
  deletions: number | null
}

export interface CollabComparison {
  ref: string
  base: string | null
  incoming: number
  outgoing: number
  commits: CollabCommit[]
  files: CollabFileChange[]
}

export interface CollabFetchResult {
  trackingRef: string
  oid: string
  upToDate: boolean
  incoming: number
  outgoing: number
  imported: Array<{ importId: string; title: string }>
  importErrors: string[]
}

export type CollabMergeResult =
  | { ok: true; merged: boolean; head: string; message: string }
  | { ok: false; error: string; conflicts?: string[] }

export interface CollabPushInput {
  peerId: string
  remoteProjectId: string
  localProjectId: string
  branch: string
  request?: { title: string; note: string }
}

export interface CollabContinueResult {
  worktree: string
  branch: string
  prompt: string
}

export type CollabResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface CollabBridge {
  overview(): Promise<CollabOverview>
  remoteProject(peerId: string, remoteProjectId: string): Promise<CollabResult<CollabRemoteProjectView>>
  link(peerId: string, remoteProjectId: string, localProjectId: string | null): Promise<CollabResult<CollabLink[]>>
  fetch(peerId: string, remoteProjectId: string, branch: string): Promise<CollabResult<CollabFetchResult>>
  compare(localProjectId: string, ref: string): Promise<CollabResult<CollabComparison>>
  fileDiff(localProjectId: string, ref: string, path: string): Promise<CollabResult<string>>
  merge(localProjectId: string, ref: string, requestId?: string): Promise<CollabMergeResult>
  abortMerge(localProjectId: string): Promise<CollabResult<true>>
  push(input: CollabPushInput): Promise<CollabResult<{ trackingRef: string; requestId: string | null }>>
  closeRequest(requestId: string): Promise<CollabResult<true>>
  continueFrom(localProjectId: string, ref: string, importId?: string): Promise<CollabResult<CollabContinueResult>>
}

export function slugForRemote(name: string, fallback: string): string {
  const trim = (value: string): string => value.replace(/^[-.]+|[-.]+$/g, '')
  const cleaned = trim(
    trim(
      name
        .replace(/^砚\s*·\s*/, '')
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/-+/g, '-')
    )
      .toLowerCase()
      .slice(0, 40)
  ).replace(/\.lock$/, '')
  const safe = cleaned || fallback.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toLowerCase() || 'peer'
  return `${COLLAB_REMOTE_PREFIX}${safe}`
}

export function trackingRefFor(remoteName: string, branch: string): string {
  return `refs/remotes/${remoteName}/${branch}`
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}
