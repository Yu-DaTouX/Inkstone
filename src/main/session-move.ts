import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { pick } from '../shared/ui-lang'

export interface SessionMovePrompt {
  dir: string
  reason: string
  cwd: string
  sessionId: string
  sessionFile: string
}

export interface SessionMoveAnswer {
  decision: 'approved' | 'denied' | 'no-answer' | 'same' | 'invalid'
  target?: string
  feedback?: string
  message: string
}

export interface MoveContinuationState {
  sessionId?: string
  sessionFile?: string
  generation?: number
  version: number
  failureVersion: number
  rpc: object | null
  ready: boolean
  stopped: boolean
  idle: boolean
}

export function captureMoveContinuation(read: () => MoveContinuationState): (afterHostStop?: boolean) => boolean {
  const origin = read()
  return (afterHostStop = false) => {
    const current = read()
    return !!origin.rpc && !!origin.sessionId && !!origin.sessionFile &&
      current.sessionId === origin.sessionId && current.sessionFile === origin.sessionFile &&
      current.generation === origin.generation && current.failureVersion === origin.failureVersion &&
      current.version === origin.version + (afterHostStop ? 1 : 0) && current.idle &&
      (afterHostStop ? current.stopped && current.rpc === null :
        !current.stopped && current.ready && current.rpc === origin.rpc)
  }
}

export function movedSessionContinuationPrompt(cwd: string): string {
  return `[砚宿主通知：会话已移动]\n这是宿主自动发出的通知，不是用户的新消息。会话已按用户批准移到新的工作目录：${JSON.stringify(cwd)}\n先看新目录的 AGENTS.md 与项目设置，再接着做上一轮没做完、用户已授权的部分；不要重放已完成的操作，这条通知也不增加任何权限。原任务已完成就简短确认。`
}

export function withSessionHeaderCwd(text: string, cwd: string): string {
  const end = text.indexOf('\n')
  const line = end < 0 ? text : text.slice(0, end)
  const rest = end < 0 ? '' : text.slice(end)
  const body = line.endsWith('\r') ? line.slice(0, -1) : line
  let header: unknown
  try {
    header = JSON.parse(body)
  } catch {
    throw new Error(pick('会话文件头不是有效的 JSON', 'The session file header is not valid JSON'))
  }
  if (!header || typeof header !== 'object' || (header as { type?: unknown }).type !== 'session') {
    throw new Error(pick('不是 pi 会话文件（首行不是会话头）', 'Not a pi session file (first line is not a session header)'))
  }
  return JSON.stringify({ ...(header as Record<string, unknown>), cwd }) + line.slice(body.length) + rest
}

export function sessionHeaderCwd(text: string): string | undefined {
  const end = text.indexOf('\n')
  try {
    const header = JSON.parse((end < 0 ? text : text.slice(0, end)).trim()) as { type?: unknown; cwd?: unknown }
    return header.type === 'session' && typeof header.cwd === 'string' ? header.cwd : undefined
  } catch {
    return undefined
  }
}

export async function rewriteSessionCwd(file: string, cwd: string): Promise<{ previousCwd?: string }> {
  const text = await readFile(file, 'utf8')
  const next = withSessionHeaderCwd(text, cwd)
  const tmp = `${file}.move-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  return { previousCwd: sessionHeaderCwd(text) }
}
