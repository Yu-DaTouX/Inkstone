import { pick } from '../../shared/ui-lang'
import { busyWorkspaceOverlap, reserveWorkspaceMutation, workspacePathsOverlap } from '../workspace-mutation'
import { isAbsolute } from 'node:path'
import { executionBusy } from '../../core/run-state'
import type { IpcRegistrar } from './registrar'
import type { SessionHost } from '../session-host'
import { assessCheckpointFit, listCheckpoints, previewCheckpoint, restoreCheckpoint } from '../checkpoints'
import type { CheckpointPreview, CheckpointRecord, CheckpointRestoreResult, WorkspaceFit } from '../../shared/checkpoints'

export interface CheckpointIpcOptions {
  activeWriterRoots?: () => readonly string[]
  busyRoots?: () => readonly string[]
}

export function registerCheckpointIpc(
  ipc: IpcRegistrar,
  host: SessionHost,
  hasSubagentWriter: (cwd: string) => boolean = () => false,
  options: CheckpointIpcOptions = {}
): void {
  const { handle } = ipc
  const target = (): { cwd: string; key: string } | null => {
    const agent = host.ac()
    const state = agent?.getState()
    if (!agent || !state) return null
    const key = state.conversationId ?? state.sessionId
    return key ? { cwd: agent.workingDirectory, key } : null
  }
  const overlappingRunnerBusy = (cwd: string): boolean => {
    const registry = host.runners()
    if (!registry) return false
    const statuses = registry.statuses()
    return statuses.some((status) => (status.running || status.waiting) && workspacePathsOverlap(status.cwd, cwd))
  }
  const restore = async (id: unknown): Promise<CheckpointRestoreResult> => {
    const t = target()
    if (!t || typeof id !== 'string') return { ok: false, error: pick('没有活动会话', 'No active session'), restored: 0 }
    const release = reserveWorkspaceMutation(t.cwd)
    if (!release) return { ok: false, error: pick('项目正在回退，请稍后重试', 'The project is being rolled back. Try again shortly'), restored: 0 }
    try {
      const registry = host.runners()
      const agent = host.ac()
      const busy = registry?.hasBusyCwd(t.cwd) || registry?.hasExecutionAdmission(t.cwd) ||
        executionBusy(agent?.getState() ?? null, () => agent?.hasRunningBash() ?? false, () => agent?.getPendingUiCount() ?? 0)
      const writer = hasSubagentWriter(t.cwd) || busyWorkspaceOverlap(t.cwd, options.activeWriterRoots?.() ?? [])
      if (writer) return { ok: false, error: pick('有子 Agent 正在这个文件夹里写文件，请等它结束或先停止再回退代码', 'A subagent is writing in this folder. Wait for it or stop it before rolling back.'), restored: 0 }
      const overlapBusy = overlappingRunnerBusy(t.cwd) || busyWorkspaceOverlap(t.cwd, options.busyRoots?.() ?? [])
      if (busy || overlapBusy) return { ok: false, error: pick('同一项目的会话仍在运行，请先停止再回退代码', 'A session in this project is still running. Stop it before rolling back code'), restored: 0 }
      return await restoreCheckpoint(t.cwd, id, t.key)
    } finally { release() }
  }
  handle('yan:checkpoints:list', async (): Promise<CheckpointRecord[]> => {
    const t = target()
    return t ? listCheckpoints(t.cwd, t.key) : []
  })
  handle('yan:checkpoints:preview', async (recordId: unknown): Promise<CheckpointPreview> => {
    const t = target()
    if (!t || typeof recordId !== 'string') return { ok: false, error: pick('没有活动会话', 'No active session'), changes: [], total: 0 }
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
