import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  COLLAB_BUNDLE_MAX_BYTES,
  COLLAB_MAX_HAVES,
  COLLAB_REQUEST_NOTE_MAX,
  slugForRemote,
  trackingRefFor,
  type CollabBranchSession,
  type CollabFailureCode,
  type CollabMergeRequest,
  type CollabProjectListing
} from '../../shared/collab'
import type { PeerOperation } from '../../shared/peer-protocol'
import type { RemoteDeviceSummary } from '../../shared/remote-protocol'
import type { RemoteOperationResult } from '../remote-server'
import {
  branchOfPath,
  bundleTempPath,
  checkBranchName,
  createBundle,
  fetchBundle,
  isOid,
  localBranches,
  normalizePath,
  pointTrackingRef,
  refTips,
  repoRootOf,
  resolveCommit,
  rootCommits,
  worktreeBranches
} from './git'

export interface PeerCollabContext {
  device: RemoteDeviceSummary
  allow(operations: PeerOperation[], projectId: string): RemoteOperationResult | null
}

export type PeerCollabReply =
  | { kind: 'json'; result: RemoteOperationResult }
  | { kind: 'file'; path: string; bytes: number; filename: string; done(): void }

export interface PeerCollabHost {
  handle(req: IncomingMessage, parts: string[], ctx: PeerCollabContext): Promise<PeerCollabReply | null>
}

export interface CollabHostProject {
  id: string
  name: string
  cwd: string
}

export interface CollabHostSession {
  id: string
  title: string
  cwd: string
  updatedAt: number
  messageCount: number
}

export interface CollabHostDeps {
  projects(): Promise<CollabHostProject[]>
  projectSessions(projectId: string): Promise<CollabHostSession[]>
  sessionBranchLinks(): Promise<Array<{ sessionId: string; branch: string }>> | Array<{ sessionId: string; branch: string }>
  projectOfSession(sessionId: string): Promise<string | null>
  exportSession(sessionId: string): Promise<RemoteOperationResult>
  onIncomingRequest(request: CollabMergeRequest): Promise<void> | void
  tempDir: string
  stateFile?: string
}

const JSON_LIMIT = 256 * 1024
const REQUEST_WINDOW_MS = 10 * 60_000
const REQUEST_LIMIT = 20

function json(result: RemoteOperationResult): PeerCollabReply {
  return { kind: 'json', result }
}

function fail(status: number, error: string, code?: CollabFailureCode): PeerCollabReply {
  return json({ ok: false, status, error, ...(code ? { code } : {}) })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > JSON_LIMIT) return null
    chunks.push(part)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function receiveFile(req: IncomingMessage, file: string): Promise<{ ok: true; bytes: number } | { ok: false; error: string; status: number; code: CollabFailureCode }> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > COLLAB_BUNDLE_MAX_BYTES) {
    return { ok: false, status: 413, error: 'The code bundle is over the size limit', code: 'bundle-too-large' }
  }
  return new Promise((resolveResult) => {
    const out = createWriteStream(file)
    let bytes = 0
    let settled = false
    const finish = (value: { ok: true; bytes: number } | { ok: false; error: string; status: number; code: CollabFailureCode }): void => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > COLLAB_BUNDLE_MAX_BYTES) {
        req.destroy()
        out.destroy()
        finish({ ok: false, status: 413, error: 'The code bundle is over the size limit', code: 'bundle-too-large' })
      }
    })
    req.on('error', () => finish({ ok: false, status: 400, error: 'The connection dropped while receiving the code bundle', code: 'bundle-transfer-failed' }))
    out.on('error', () => finish({ ok: false, status: 500, error: 'Could not write the temporary file', code: 'bundle-transfer-failed' }))
    out.on('finish', () => finish({ ok: true, bytes }))
    req.pipe(out)
  })
}

export function createCollabHost(deps: CollabHostDeps): PeerCollabHost {
  const requestTimes = new Map<string, number[]>()
  const projectOf = async (projectId: string): Promise<{ project: CollabHostProject; root: string } | PeerCollabReply> => {
    const project = (await deps.projects()).find((item) => item.id === projectId)
    if (!project) return fail(404, 'That project could not be found', 'peer-project-missing')
    const root = await repoRootOf(project.cwd)
    if (!root) return fail(409, 'That project is not a Git repository', 'peer-project-not-repo')
    return { project, root }
  }

  const branchSessions = async (projectId: string, root: string): Promise<Map<string, CollabBranchSession[]>> => {
    const sessions = await deps.projectSessions(projectId)
    const worktrees = await worktreeBranches(root)
    worktrees.delete(normalizePath(root))
    const linked = new Map((await deps.sessionBranchLinks()).map((link) => [link.sessionId, link.branch]))
    const out = new Map<string, CollabBranchSession[]>()
    for (const session of sessions) {
      const branch = linked.get(session.id) ?? branchOfPath(worktrees, session.cwd)
      if (!branch) continue
      const list = out.get(branch) ?? []
      list.push({ sessionId: session.id, title: session.title, updatedAt: session.updatedAt, messageCount: session.messageCount })
      out.set(branch, list)
    }
    for (const list of out.values()) list.sort((a, b) => b.updatedAt - a.updatedAt).splice(10)
    return out
  }

  const listing = async (projectId: string): Promise<PeerCollabReply> => {
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    const sessions = await branchSessions(projectId, found.root)
    const branches = (await localBranches(found.root)).map((branch) => ({ ...branch, sessions: sessions.get(branch.name) ?? [] }))
    const data: CollabProjectListing = {
      projectId,
      projectName: found.project.name,
      rootCommits: await rootCommits(found.root),
      tips: await refTips(found.root),
      branches
    }
    return json({ ok: true, data })
  }

  const bundle = async (req: IncomingMessage, projectId: string): Promise<PeerCollabReply> => {
    const body = await readJson(req)
    if (!body) return fail(400, 'The request body is not valid', 'request-invalid')
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const invalid = checkBranchName(branch)
    if (invalid) return fail(400, invalid.error, invalid.code)
    const haves = Array.isArray(body.haves) ? body.haves.filter(isOid).slice(0, COLLAB_MAX_HAVES) : []
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    await mkdir(deps.tempDir, { recursive: true })
    const file = bundleTempPath(deps.tempDir, 'out')
    const outcome = await createBundle(found.root, branch, haves, file)
    if (outcome.kind === 'error') {
      await rm(file, { force: true })
      return fail(409, outcome.error, outcome.code)
    }
    if (outcome.kind === 'up-to-date') {
      await rm(file, { force: true })
      return json({ ok: true, data: { upToDate: true, oid: outcome.oid } })
    }
    const info = await stat(file)
    return {
      kind: 'file',
      path: file,
      bytes: info.size,
      filename: `${branch.replace(/[^\w.-]+/g, '-')}.bundle`,
      done: () => void rm(file, { force: true })
    }
  }

  const receivePush = async (req: IncomingMessage, url: URL, projectId: string, device: RemoteDeviceSummary): Promise<PeerCollabReply> => {
    const branch = url.searchParams.get('branch') ?? ''
    const oid = url.searchParams.get('oid') ?? ''
    const invalid = checkBranchName(branch)
    if (invalid) return fail(400, invalid.error, invalid.code)
    if (!isOid(oid)) return fail(400, 'That commit id is not valid', 'peer-oid-invalid')
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    const trackingRef = trackingRefFor(slugForRemote(device.name, device.id), branch)
    if (url.searchParams.get('known') === '1') {
      const pointed = await pointTrackingRef(found.root, trackingRef, oid)
      return pointed.ok ? json({ ok: true, data: { trackingRef, oid } }) : fail(409, pointed.error, pointed.code)
    }
    await mkdir(deps.tempDir, { recursive: true })
    const file = bundleTempPath(deps.tempDir, 'in')
    try {
      const received = await receiveFile(req, file)
      if (!received.ok) return fail(received.status, received.error, received.code)
      const fetched = await fetchBundle(found.root, file, branch, trackingRef, oid)
      if (!fetched.ok) return fail(409, fetched.error, fetched.code)
      return json({ ok: true, data: { trackingRef, oid } })
    } finally {
      await rm(file, { force: true })
    }
  }

  const openRequest = async (req: IncomingMessage, projectId: string, device: RemoteDeviceSummary): Promise<PeerCollabReply> => {
    const body = await readJson(req)
    if (!body) return fail(400, 'The request body is not valid', 'request-invalid')
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const invalid = checkBranchName(branch)
    if (invalid) return fail(400, invalid.error, invalid.code)
    if (!isOid(body.oid)) return fail(400, 'That commit id is not valid', 'peer-oid-invalid')
    const now = Date.now()
    const recent = (requestTimes.get(device.id) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS)
    if (recent.length >= REQUEST_LIMIT) {
      return fail(429, 'Merge requests are being sent too often; try again later', 'request-rate-limited')
    }
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    const trackingRef = trackingRefFor(slugForRemote(device.name, device.id), branch)
    if ((await resolveCommit(found.root, trackingRef)) !== body.oid) {
      return fail(409, 'Push this branch before opening a merge request', 'request-branch-unpushed')
    }
    requestTimes.set(device.id, [...recent, now])
    const clean = (value: unknown, max: number): string =>
      typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
    const request: CollabMergeRequest = {
      id: `mr-${randomUUID()}`,
      direction: 'incoming',
      peerName: device.name,
      peerDeviceId: device.id,
      localProjectId: projectId,
      projectName: found.project.name,
      branch,
      trackingRef,
      oid: body.oid,
      title: clean(body.title, 200) || branch,
      note: clean(body.note, COLLAB_REQUEST_NOTE_MAX),
      createdAt: Date.now(),
      status: 'open'
    }
    await deps.onIncomingRequest(request)
    return json({ ok: true, data: { requestId: request.id } })
  }

  return {
    async handle(req, parts, ctx) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && parts[0] === 'projects' && parts.length === 4 && parts[2] === 'requests') {
        const projectId = decodeURIComponent(parts[1])
        const denied = ctx.allow(['push'], projectId)
        if (denied) return json(denied)
        let requests: CollabMergeRequest[]
        try {
          const state = JSON.parse(await readFile(deps.stateFile ?? join(YAN_DIR, 'collab.json'), 'utf8'))
          if (state?.version !== 1 || !Array.isArray(state.requests)) {
            return fail(503, 'The merge request state cannot be read right now', 'request-state-unreadable')
          }
          requests = state.requests
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail(404, 'That merge request could not be found', 'request-missing')
          return fail(503, 'The merge request state cannot be read right now', 'request-state-unreadable')
        }
        const request = requests.find((item) => item.id === decodeURIComponent(parts[3]) && item.direction === 'incoming' && item.localProjectId === projectId && item.peerDeviceId === ctx.device.id)
        if (!request) return fail(404, 'That merge request could not be found', 'request-missing')
        const revoked = ctx.allow(['push'], projectId)
        if (revoked) return json(revoked)
        return json({ ok: true, data: { requestId: request.id, projectId, branch: request.branch, oid: request.oid, status: request.status } })
      }
      if (parts[0] === 'projects' && parts.length === 3) {
        const projectId = decodeURIComponent(parts[1])
        const action = parts[2]
        if (req.method === 'GET' && action === 'branches') {
          const denied = ctx.allow(['pull', 'push'], projectId)
          return denied ? json(denied) : listing(projectId)
        }
        if (req.method === 'POST' && action === 'bundle') {
          const denied = ctx.allow(['pull'], projectId)
          return denied ? json(denied) : bundle(req, projectId)
        }
        if (req.method === 'POST' && action === 'push') {
          const denied = ctx.allow(['push'], projectId)
          return denied ? json(denied) : receivePush(req, url, projectId, ctx.device)
        }
        if (req.method === 'POST' && action === 'requests') {
          const denied = ctx.allow(['push'], projectId)
          return denied ? json(denied) : openRequest(req, projectId, ctx.device)
        }
      }
      if (req.method === 'GET' && parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'export') {
        const sessionId = decodeURIComponent(parts[1])
        const projectId = await deps.projectOfSession(sessionId)
        if (!projectId) {
          return fail(404, 'That session could not be found, or it does not belong to a shared project', 'session-export-failed')
        }
        const denied = ctx.allow(['pull'], projectId)
        return denied ? json(denied) : json(await deps.exportSession(sessionId))
      }
      return null
    }
  }
}
