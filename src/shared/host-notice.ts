import { isSubagentNotice } from './subagent-notice'
import { QUOTA_RESUME_PROMPT } from './quota-resume'

export type HostNotice =
  | { kind: 'subagent' }
  | { kind: 'session-moved'; cwd: string }
  | { kind: 'auto-continue'; reason: 'loop' | 'model-error' }
  | { kind: 'quota-resume' }

const MOVE_HEAD = /^\[砚宿主通知：(?:用户批准的会话移动已完成|会话已移动)\]/
const MOVE_CWD = /(?:当前工作目录（路径数据）|新的工作目录)：("(?:[^"\\]|\\.)*")/

export function parseHostNotice(text: string | undefined): HostNotice | null {
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
  if (isSubagentNotice(body)) return { kind: 'subagent' }
  return null
}
