import { dialog, type BrowserWindow } from 'electron'
import { PEER_OPERATIONS } from '../../shared/peer-protocol'
import type { PeerClient, PeerIdentity } from '../peer-client'
import type { IpcRegistrar } from './registrar'
import { pick } from '../../shared/ui-lang'

export interface PeerIpcDeps {
  window?(): BrowserWindow | null
}

export function registerPeerIpc(ipc: IpcRegistrar, client: PeerClient, deps: PeerIpcDeps = {}): void {
  const { handle } = ipc
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const confirmIdentity = async (identity: PeerIdentity): Promise<boolean> => {
    const fingerprint = identity.fingerprint?.trim() || pick('（对方没有提供指纹）', '(the other computer did not report a fingerprint)')
    const options = {
      type: 'question' as const,
      title: pick('核对另一台电脑的身份', 'Verify the other computer'),
      message: pick(`即将连接「${identity.computer}」。请与那台电脑「设置 → 设备连接」里显示的「主机指纹」逐段核对。`,
        `About to connect to "${identity.computer}". Compare the host fingerprint with the one shown under Settings → Devices on that computer.`
      ),
      detail: `${identity.computer}\n${fingerprint}`,
      buttons: [pick('指纹一致，连接', 'Fingerprints match, connect'), pick('取消', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const win = deps.window?.() ?? null
    const answer = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return answer.response === 0
  }
  handle('yan:peer:status', () => client.status())
  handle('yan:peer:pair', (address: unknown, code: unknown) => client.pair(str(address), str(code), confirmIdentity))
  handle('yan:peer:remove', (peerId: unknown) => client.remove(str(peerId)))
  handle('yan:peer:connect', (peerId: unknown, operations: unknown, note: unknown) =>
    client.connect(str(peerId), Array.isArray(operations) ? PEER_OPERATIONS.filter((op) => operations.includes(op)) : [], str(note).slice(0, 200))
  )
  handle('yan:peer:disconnect', (peerId: unknown) => client.endConnection(str(peerId)))
  handle('yan:peer:sessions', (peerId: unknown) => client.sessions(str(peerId)))
  handle('yan:peer:history', (peerId: unknown, sessionId: unknown, before: unknown) =>
    client.history(str(peerId), str(sessionId), str(before) || undefined)
  )
  handle('yan:peer:send', (peerId: unknown, sessionId: unknown, text: unknown) => client.send(str(peerId), str(sessionId), str(text)))
  handle('yan:peer:startSession', (peerId: unknown, projectId: unknown, text: unknown) => client.startSession(str(peerId), str(projectId), str(text)))
  handle('yan:peer:abort', (peerId: unknown, runId: unknown) => client.abort(str(peerId), str(runId)))
  handle('yan:peer:importSession', (peerId: unknown, sessionId: unknown) => client.importSession(str(peerId), str(sessionId)))
}
