/**
 * 检查点（回退代码）的 IPC 适配：列出、预览、恢复、撤销。
 * 目录与会话身份都取当前活动实例，渲染端不能指定别的目录。
 */
import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { listCheckpoints, previewCheckpoint, restoreCheckpoint } from '../checkpoints'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult } from '../../shared/checkpoints'

export function registerCheckpointIpc(ipc: IpcRegistrar, host: SessionHost): void {
  const { handle } = ipc
  /** 当前活动会话的项目目录与会话键；没有活动会话就是 null */
  const target = (): { cwd: string; key: string } | null => {
    const agent = host.ac()
    const state = agent?.getState()
    if (!agent || !state) return null
    const key = state.conversationId ?? state.sessionId
    return key ? { cwd: agent.workingDirectory, key } : null
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
    const t = target()
    if (!t || typeof recordId !== 'string') return { ok: false, error: '没有活动会话', restored: 0 }
    /* 回退会改文件：正在跑的回合可能正在写同一批文件，先要求它停下 */
    if (host.ac()?.getState()?.isAgentRunning) return { ok: false, error: '会话正在运行，请先停止再回退代码', restored: 0 }
    return restoreCheckpoint(t.cwd, recordId, t.key)
  })
  handle('yan:checkpoints:undo', async (undoId: unknown): Promise<CheckpointRestoreResult> => {
    const t = target()
    if (!t || typeof undoId !== 'string') return { ok: false, error: '没有活动会话', restored: 0 }
    if (host.ac()?.getState()?.isAgentRunning) return { ok: false, error: '会话正在运行，请先停止再撤销', restored: 0 }
    return restoreCheckpoint(t.cwd, undoId, t.key)
  })
}
