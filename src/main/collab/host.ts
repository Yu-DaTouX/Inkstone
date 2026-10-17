import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  COLLAB_BUNDLE_MAX_BYTES,
  COLLAB_MAX_HAVES,
  COLLAB_REQUEST_NOTE_MAX,
  slugForRemote,
  trackingRefFor,
  type CollabBranchSession,
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
}

const JSON_LIMIT = 256 * 1024
const REQUEST_WINDOW_MS = 10 * 60_000
const REQUEST_LIMIT = 20

function json(result: RemoteOperationResult): PeerCollabReply {
  return { kind: 'json', result }
}

function fail(status: number, error: string, code?: string): PeerCollabReply {
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

async function receiveFile(req: IncomingMessage, file: string): Promise<{ ok: true; bytes: number } | { ok: false; error: string; status: number }> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > COLLAB_BUNDLE_MAX_BYTES) return { ok: false, status: 413, error: '代码包超过 512MB 上限' }
  return new Promise((resolveResult) => {
    const out = createWriteStream(file)
    let bytes = 0
    let settled = false
    const finish = (value: { ok: true; bytes: number } | { ok: false; error: string; status: number }): void => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > COLLAB_BUNDLE_MAX_BYTES) {
        req.destroy()
        out.destroy()
        finish({ ok: false, status: 413, error: '代码包超过 512MB 上限' })
      }
    })
    req.on('error', () => finish({ ok: false, status: 400, error: '接收代码包时连接中断' }))
    out.on('error', () => finish({ ok: false, status: 500, error: '写入临时文件失败' }))
    out.on('finish', () => finish({ ok: true, bytes }))
    req.pipe(out)
  })
}

export function createCollabHost(deps: CollabHostDeps): PeerCollabHost {
  const requestTimes = new Map<string, number[]>()
  const projectOf = async (projectId: string): Promise<{ project: CollabHostProject; root: string } | PeerCollabReply> => {
    const project = (await deps.projects()).find((item) => item.id === projectId)
    if (!project) return fail(404, '找不到这个项目')
    const root = await repoRootOf(project.cwd)
    if (!root) return fail(409, '这个项目不是 Git 仓库')
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
    if (!body) return fail(400, '请求格式无效')
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const invalid = checkBranchName(branch)
    if (invalid) return fail(400, invalid)
    const haves = Array.isArray(body.haves) ? body.haves.filter(isOid).slice(0, COLLAB_MAX_HAVES) : []
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    await mkdir(deps.tempDir, { recursive: true })
    const file = bundleTempPath(deps.tempDir, 'out')
    const outcome = await createBundle(found.root, branch, haves, file)
    if (outcome.kind === 'error') {
      await rm(file, { force: true })
      return fail(409, outcome.error)
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
    if (invalid) return fail(400, invalid)
    if (!isOid(oid)) return fail(400, '提交号无效')
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    const trackingRef = trackingRefFor(slugForRemote(device.name, device.id), branch)
    if (url.searchParams.get('known') === '1') {
      const pointed = await pointTrackingRef(found.root, trackingRef, oid)
      return pointed.ok ? json({ ok: true, data: { trackingRef, oid } }) : fail(409, pointed.error)
    }
    await mkdir(deps.tempDir, { recursive: true })
    const file = bundleTempPath(deps.tempDir, 'in')
    try {
      const received = await receiveFile(req, file)
      if (!received.ok) return fail(received.status, received.error)
      const fetched = await fetchBundle(found.root, file, branch, trackingRef, oid)
      if (!fetched.ok) return fail(409, fetched.error)
      return json({ ok: true, data: { trackingRef, oid } })
    } finally {
      await rm(file, { force: true })
    }
  }

  const openRequest = async (req: IncomingMessage, projectId: string, device: RemoteDeviceSummary): Promise<PeerCollabReply> => {
    const body = await readJson(req)
    if (!body) return fail(400, '请求格式无效')
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const invalid = checkBranchName(branch)
    if (invalid) return fail(400, invalid)
    if (!isOid(body.oid)) return fail(400, '提交号无效')
    const now = Date.now()
    const recent = (requestTimes.get(device.id) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS)
    if (recent.length >= REQUEST_LIMIT) return fail(429, '合并请求发得太频繁，请稍后再试')
    const found = await projectOf(projectId)
    if ('kind' in found) return found
    const trackingRef = trackingRefFor(slugForRemote(device.name, device.id), branch)
    if ((await resolveCommit(found.root, trackingRef)) !== body.oid) return fail(409, '先推送这个分支，再发合并请求')
    requestTimes.set(device.id, [...recent, now])
    const clean = (value: unknown, max: number): string =>
      typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
    const request: CollabMergeRequest = {
      id: `mr-${randomUUID()}`,
      direction: 'incoming',
      peerName: device.name,
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
        if (!projectId) return fail(404, '找不到这个会话，或它不属于任何开放的项目')
        const denied = ctx.allow(['pull'], projectId)
        return denied ? json(denied) : json(await deps.exportSession(sessionId))
      }
      return null
    }
  }
}
