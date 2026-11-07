export const QUOTA_RESUME_PROMPT = '额度已恢复，请从上一轮中断的地方继续完成任务。'

export type HostTextNotice =
  | { kind: 'session-moved'; cwd: string }
  | { kind: 'auto-continue'; reason: 'loop' | 'model-error' }
  | { kind: 'quota-resume' }

const MOVE_HEAD = /^\[砚宿主通知：(?:用户批准的会话移动已完成|会话已移动)\]/
const MOVE_CWD = /(?:当前工作目录（路径数据）|新的工作目录)：("(?:[^"\\]|\\.)*")/

export function parseHostTextNotice(text: string | undefined): HostTextNotice | null {
  const body = (text ?? '').trim()
  if (!body) return null
  if (MOVE_HEAD.test(body)) {
    let cwd = ''
    const raw = MOVE_CWD.exec(body)?.[1]
    if (raw) try { cwd = String(JSON.parse(raw)) } catch { cwd = '' }
    return { kind: 'session-moved', cwd }
  }
  if (body.startsWith('[循环恢复 · 自动继续')) return { kind: 'auto-continue', reason: 'loop' }
  if (body.startsWith('[模型错误恢复 · 自动继续')) return { kind: 'auto-continue', reason: 'model-error' }
  if (body === QUOTA_RESUME_PROMPT) return { kind: 'quota-resume' }
  return null
}
