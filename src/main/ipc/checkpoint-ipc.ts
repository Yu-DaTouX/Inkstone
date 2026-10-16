import { reserveWorkspaceMutation } from '../workspace-mutation'
import { resolve } from 'node:path'
import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { listCheckpoints, previewCheckpoint, restoreCheckpoint } from '../checkpoints'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult } from '../../shared/checkpoints'

export function registerCheckpointIpc(ipc: IpcRegistrar, host: SessionHost): void {
  const { handle } = ipc
  const target = (): { cwd: string; key: string } | null => {
    const agent = host.ac()
    const state = agent?.getState()
    if (!agent || !state) return null
    const key = state.conversationId ?? state.sessionId
    return key ? { cwd: agent.workingDirectory, key } : null
  }
  const restore = async (id: unknown): Promise<CheckpointRestoreResult> => {
    const t = target()
    if (!t || typeof id !== 'string') return { ok: false, error: '没有活动会话', restored: 0 }
    const release = reserveWorkspaceMutation(t.cwd)
    if (!release) return { ok: false, error: '项目正在回退，请稍后重试', restored: 0 }
    const cwdKey = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
    try {
      const busy = host.runners()?.statuses().some((runner) => cwdKey(runner.cwd) === cwdKey(t.cwd) && (runner.running || runner.waiting || (host.runners()?.agentOf(runner.id)?.getState()?.pendingMessageCount ?? 0) > 0))
      if (busy || host.ac()?.getState()?.isAgentRunning || (host.ac()?.getState()?.pendingMessageCount ?? 0) > 0) return { ok: false, error: '同一项目的会话仍在运行，请先停止再回退代码', restored: 0 }
      return await restoreCheckpoint(t.cwd, id, t.key)
    } finally { release() }
  }
  handle('yan:checkpoints:list', async (): Promise<CheckpointRecord[]> => {
    const t = target()
    return t ? listCheckpoints(t.cwd, t.key) : []
  })
  handle('yan:checkpoints:preview', async (recordId: unknown): Promise<CheckpointPreview> => {
    const t = target()
    if (!t || typeof recordId !== 'string') return { ok: false, error: '没有活动会话', changes: [], total: 0 }
    return previewCheckpoint(t.cwd, recordId)
  })
  handle('yan:checkpoints:restore', async (recordId: unknown): Promise<CheckpointRestoreResult> => {
    return restore(recordId)
  })
  handle('yan:checkpoints:undo', async (undoId: unknown): Promise<CheckpointRestoreResult> => {
    return restore(undoId)
  })
}
