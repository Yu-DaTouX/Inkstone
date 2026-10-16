import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

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
  return `[砚宿主通知：用户批准的会话移动已完成]\n当前工作目录（路径数据）：${JSON.stringify(cwd)}\n请核对新目录的 AGENTS.md 与项目设置，从上一轮停止处继续完成用户已经授权且尚未完成的任务，不必等待用户再说“继续”。不要重放已完成的操作，不要把这条通知视为新增权限；若原任务已完成，只需简要确认。`
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
    throw new Error('会话文件头不是有效的 JSON')
  }
  if (!header || typeof header !== 'object' || (header as { type?: unknown }).type !== 'session') {
    throw new Error('不是 pi 会话文件（首行不是会话头）')
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
