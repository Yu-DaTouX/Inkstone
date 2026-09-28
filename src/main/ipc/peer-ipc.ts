/**
 * 砚对砚：连接者一侧的 IPC 适配（`yan:peer:*`）。
 * 对方地址只来自用户输入并在 PeerClient 里规范化；本机项目只按 id 从设置里取，渲染端不能传路径。
 */
import { shell } from 'electron'
import { PEER_OPERATIONS } from '../../shared/peer-protocol'
import type { ProjectRecord } from '../../shared/ipc'
import type { PeerClient } from '../peer-client'
import type { IpcRegistrar } from './registrar'

export function registerPeerIpc(ipc: IpcRegistrar, client: PeerClient, projects: () => Promise<ProjectRecord[]>): void {
  const { handle } = ipc
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  handle('yan:peer:status', () => client.status())
  handle('yan:peer:pair', (address: unknown, code: unknown) => client.pair(str(address), str(code)))
  handle('yan:peer:remove', (peerId: unknown) => client.remove(str(peerId)))
  handle('yan:peer:connect', (peerId: unknown, operations: unknown, note: unknown) =>
    client.connect(str(peerId), Array.isArray(operations) ? PEER_OPERATIONS.filter((op) => operations.includes(op)) : [], str(note).slice(0, 200))
  )
  handle('yan:peer:disconnect', (peerId: unknown) => client.disconnect(str(peerId)))
  handle('yan:peer:sessions', (peerId: unknown) => client.sessions(str(peerId)))
  handle('yan:peer:history', (peerId: unknown, sessionId: unknown, before: unknown) =>
    client.history(str(peerId), str(sessionId), str(before) || undefined)
  )
  handle('yan:peer:send', (peerId: unknown, sessionId: unknown, text: unknown) => client.send(str(peerId), str(sessionId), str(text)))
  handle('yan:peer:abort', (peerId: unknown, runId: unknown) => client.abort(str(peerId), str(runId)))
  handle('yan:peer:importSession', (peerId: unknown, sessionId: unknown) => client.importSession(str(peerId), str(sessionId)))
  handle('yan:peer:importKnowledge', async (peerId: unknown, remoteProjectId: unknown, localProjectId: unknown) => {
    const local = (await projects()).find((project) => project.id === localProjectId)
    if (!local) return { ok: false, error: '请先选择本机的一个项目' }
    return client.importKnowledge(str(peerId), str(remoteProjectId), local)
  })
  handle('yan:peer:readImport', (importId: unknown) => client.readImport(str(importId)))
  handle('yan:peer:revealImport', async (importId: unknown) => {
    const found = await client.readImport(str(importId))
    if (found.ok) await shell.openPath(found.data.dir)
    return found.ok
  })
}
