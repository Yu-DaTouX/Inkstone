import { reserveWorkspaceMutation } from '../workspace-mutation'
import { isAbsolute } from 'node:path'
import { executionBusy } from '../../core/run-state'
import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { assessCheckpointFit, listCheckpoints, previewCheckpoint, restoreCheckpoint } from '../checkpoints'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult, WorkspaceFit } from '../../shared/checkpoints'

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
    try {
      const registry = host.runners()
      const agent = host.ac()
      const busy = registry?.hasBusyCwd(t.cwd) || registry?.hasExecutionAdmission(t.cwd) ||
        executionBusy(agent?.getState() ?? null, () => agent?.hasRunningBash() ?? false, () => agent?.getPendingUiCount() ?? 0)
      if (busy) return { ok: false, error: '同一项目的会话仍在运行，请先停止再回退代码', restored: 0 }
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
  handle('yan:checkpoints:assess', async (cwd: unknown): Promise<WorkspaceFit | null> => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
    return assessCheckpointFit(cwd).catch(() => null)
  })
}
