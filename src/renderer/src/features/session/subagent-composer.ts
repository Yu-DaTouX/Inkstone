import type { SubagentRun } from '../../../../shared/ipc'

type SubagentComposerMode = 'steer' | 'resume' | 'busy' | 'hidden'

export function subagentComposerMode(run: Pick<SubagentRun, 'status' | 'isolation' | 'launchFailed' | 'wrapUp'>): SubagentComposerMode {
  if (run.isolation === 'worktree' && run.status !== 'running') return 'hidden'
  if (run.status === 'starting') return 'busy'
  if (run.status === 'running') return run.wrapUp ? 'busy' : 'steer'
  if (run.launchFailed) return 'hidden'
  return 'resume'
}

const FORWARDED_PREFIX = /^【(?:用户|主会话)追加】[^\n]*\n\n/

export function forwardedText(text: string): { text: string; forwarded: boolean } {
  const match = FORWARDED_PREFIX.exec(text)
  return match ? { text: text.slice(match[0].length), forwarded: true } : { text, forwarded: false }
}
