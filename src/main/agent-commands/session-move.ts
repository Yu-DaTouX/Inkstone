import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import type { SessionMoveAnswer, SessionMovePrompt } from '../session-move'

export interface SessionMoveHost {
  cwd(): string
  session(): { sessionId?: string; sessionFile?: string }
  sessionMover(): ((request: SessionMovePrompt) => Promise<SessionMoveAnswer>) | undefined
}

export async function runSessionMoveCommand(host: SessionMoveHost, params: Record<string, unknown>): Promise<CapabilityCommandResult> {
  const dir = typeof params.dir === 'string' ? params.dir.trim().slice(0, 1000) : ''
  if (!dir) throw new CapabilityCommandError('session_move_dir_required', '缺少 --dir（要移到的文件夹）')
  const reason = typeof params.reason === 'string' ? params.reason.trim().slice(0, 300) : ''
  const requestSessionMove = host.sessionMover()
  if (!requestSessionMove) throw new CapabilityCommandError('session_move_unavailable', '移动会话当前不可用（宿主未注入）')
  const { sessionId, sessionFile } = host.session()
  if (!sessionId || !sessionFile) {
    throw new CapabilityCommandError('session_move_unsaved', '会话还没有保存到文件，暂时不能移动；先完成这一轮再试')
  }
  const answer = await requestSessionMove({ dir, reason, cwd: host.cwd(), sessionId, sessionFile })
  return {
    data: answer,
    summary: {
      kind: 'session-move',
      decision: answer.decision,
      target: answer.target ?? dir,
      allowed: answer.decision === 'approved',
      ...(answer.feedback ? { feedback: answer.feedback, message: answer.message } : {})
    }
  }
}
