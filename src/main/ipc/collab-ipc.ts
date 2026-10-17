import { Notification, type BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcRegistrar } from './registrar'
import type { CollabMergeRequest, CollabPushInput } from '../../shared/collab'
import { CollabService } from '../collab/service'
import { createCollabHost } from '../collab/host'
import { createWorktree } from '../git-worktree'
import { getSettings } from '../settings'
import { listSessions } from '../sessions'
import { YAN_DIR } from '../paths'
import type { PeerClient } from '../peer-client'
import type { PeerHostHandlers } from '../remote-server'
import type { WorktreeLinkStore } from '../worktree-links'

export interface CollabIpcDeps {
  peerClient: PeerClient
  peerHost: PeerHostHandlers
  worktreeLinks: WorktreeLinkStore
  win(): BrowserWindow | null
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

async function activeProjects(): Promise<Array<{ id: string; name: string; cwd: string }>> {
  return (await getSettings()).projects.filter((project) => !project.archived).map(({ id, name, cwd }) => ({ id, name, cwd }))
}

function notifyIncoming(win: BrowserWindow | null, request: CollabMergeRequest): void {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
  if (!Notification.isSupported()) return
  new Notification({ title: '多人协作 · 合并请求', body: `${request.peerName.replace(/^砚\s*·\s*/, '')}：${request.title}（${request.branch}）` }).show()
}

export function registerCollabIpc(ipc: IpcRegistrar, deps: CollabIpcDeps): CollabService {
  const tempDir = join(tmpdir(), 'yan-collab')
  const service = new CollabService({
    stateFile: join(YAN_DIR, 'collab.json'),
    tempDir,
    transport: deps.peerClient,
    peerStatus: () => deps.peerClient.status(),
    localProjects: activeProjects,
    importSession: (peerId, sessionId) => deps.peerClient.importSession(peerId, sessionId, 'collab'),
    readImportDir: async (importId) => {
      const found = await deps.peerClient.readImport(importId)
      return found.ok ? found.data.dir : null
    },
    createWorktree: async ({ cwd, branch, startPoint }) => {
      const created = await createWorktree({ cwd, branch, startPoint, targetPath: null })
      if (!created.ok || !created.path) return { ok: false, error: created.failure?.message ?? '创建工作树失败' }
      return { ok: true, path: created.path, branch: created.branch ?? branch }
    },
    notifyIncoming: (request) => notifyIncoming(deps.win(), request)
  })

  deps.peerHost.collab = createCollabHost({
    tempDir,
    projects: activeProjects,
    projectSessions: async (projectId) => {
      const settings = await getSettings()
      return (await listSessions(500, settings.projects))
        .filter((summary) => summary.projectId === projectId)
        .map((summary) => ({ id: summary.id, title: summary.title, cwd: summary.cwd, updatedAt: summary.updatedAt, messageCount: summary.messageCount }))
    },
    sessionBranchLinks: async () => {
      await deps.worktreeLinks.load()
      return deps.worktreeLinks.links().map((link) => ({ sessionId: link.sessionId, branch: link.branch }))
    },
    projectOfSession: (sessionId) => deps.peerHost.projectOfSession(sessionId),
    exportSession: (sessionId) => deps.peerHost.exportSession(sessionId),
    onIncomingRequest: (request) => service.receiveRequest(request)
  })

  const { handle } = ipc
  handle('yan:collab:overview', () => service.overview())
  handle('yan:collab:remoteProject', (peerId: unknown, projectId: unknown) => service.remoteProject(str(peerId), str(projectId)))
  handle('yan:collab:link', (peerId: unknown, projectId: unknown, localProjectId: unknown) =>
    service.link(str(peerId), str(projectId), typeof localProjectId === 'string' && localProjectId ? localProjectId : null)
  )
  handle('yan:collab:fetch', (peerId: unknown, projectId: unknown, branch: unknown) => service.fetch(str(peerId), str(projectId), str(branch)))
  handle('yan:collab:compare', (localProjectId: unknown, ref: unknown) => service.compare(str(localProjectId), str(ref)))
  handle('yan:collab:fileDiff', (localProjectId: unknown, ref: unknown, path: unknown) => service.fileDiff(str(localProjectId), str(ref), str(path)))
  handle('yan:collab:merge', (localProjectId: unknown, ref: unknown, requestId: unknown) =>
    service.merge(str(localProjectId), str(ref), typeof requestId === 'string' && requestId ? requestId : undefined)
  )
  handle('yan:collab:abortMerge', (localProjectId: unknown) => service.abortMerge(str(localProjectId)))
  handle('yan:collab:push', (raw: unknown) => {
    const input = (raw ?? {}) as Partial<CollabPushInput>
    const request = input.request && typeof input.request === 'object'
      ? { title: str(input.request.title), note: str(input.request.note) }
      : undefined
    return service.push({
      peerId: str(input.peerId),
      remoteProjectId: str(input.remoteProjectId),
      localProjectId: str(input.localProjectId),
      branch: str(input.branch),
      ...(request ? { request } : {})
    })
  })
  handle('yan:collab:closeRequest', (requestId: unknown) => service.closeRequest(str(requestId)))
  handle('yan:collab:continueFrom', (localProjectId: unknown, ref: unknown, importId: unknown) =>
    service.continueFrom(str(localProjectId), str(ref), typeof importId === 'string' && importId ? importId : undefined)
  )
  return service
}
