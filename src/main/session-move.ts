import { open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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

function headerLine(text: string): { header: Record<string, unknown>; rest: string } {
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
  return { header: header as Record<string, unknown>, rest: line.slice(body.length) + rest }
}

export function withSessionHeaderCwd(text: string, cwd: string): string {
  const { header, rest } = headerLine(text)
  return JSON.stringify({ ...header, cwd }) + rest
}

export function sessionHeaderCwd(text: string): string | undefined {
  try {
    const { header } = headerLine(text)
    return typeof header.cwd === 'string' ? header.cwd : undefined
  } catch {
    return undefined
  }
}

function headerCwdOf(raw: Buffer): string | undefined {
  const end = raw.indexOf(0x0a)
  try {
    const header = JSON.parse((end < 0 ? raw : raw.subarray(0, end)).toString('utf8').trim()) as { cwd?: unknown }
    return typeof header.cwd === 'string' ? header.cwd : undefined
  } catch {
    return undefined
  }
}

function replaceHeaderCwd(raw: Buffer, cwd: string): Buffer {
  const end = raw.indexOf(0x0a)
  const line = (end < 0 ? raw : raw.subarray(0, end)).toString('utf8')
  const next = withSessionHeaderCwd(line, cwd)
  return end < 0 ? Buffer.from(next, 'utf8') : Buffer.concat([Buffer.from(next, 'utf8'), raw.subarray(end)])
}

export interface SessionMoveLease {
  readonly token: symbol
  release(): void
}

const moveLocks = new Map<string, symbol>()

function lockKey(file: string): string {
  const full = resolve(file)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export function sessionMoveInProgress(file: string): boolean {
  if (!file) return false
  return moveLocks.has(lockKey(file))
}

export function beginSessionMove(file: string): SessionMoveLease | null {
  if (!file) return null
  const key = lockKey(file)
  if (moveLocks.has(key)) return null
  const token = Symbol('session-move')
  moveLocks.set(key, token)
  const release = (): void => {
    if (moveLocks.get(key) === token) moveLocks.delete(key)
  }
  return { token, release }
}

const REWRITE_ATTEMPTS = 5

async function readStableSnapshot(file: string): Promise<{ raw: Buffer; mtimeNs: bigint } | null> {
  const fh = await open(file, 'r')
  try {
    const before = await fh.stat({ bigint: true })
    if (!before.isFile()) throw new Error(pick('不是普通文件，不能改写会话头', 'Not a regular file; the session header cannot be rewritten'))
    const raw = await fh.readFile()
    const after = await fh.stat({ bigint: true })
    if (Number(after.size) !== raw.length || after.mtimeNs !== before.mtimeNs) return null
    return { raw, mtimeNs: before.mtimeNs }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

async function rewriteOnce(file: string, cwd: string): Promise<{ previousCwd?: string }> {
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt++) {
    const snapshot = await readStableSnapshot(file)
    if (!snapshot) continue
    const previousCwd = headerCwdOf(snapshot.raw)
    const next = replaceHeaderCwd(snapshot.raw, cwd)
    const tmp = `${file}.move-${process.pid}-${Date.now()}-${attempt}.tmp`
    try {
      await writeFile(tmp, next)
      const latest = await stat(file, { bigint: true })
      if (Number(latest.size) !== snapshot.raw.length || latest.mtimeNs !== snapshot.mtimeNs) {
        await unlink(tmp).catch(() => undefined)
        continue
      }
      await rename(tmp, file)
      return { previousCwd }
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      throw error
    }
  }
  throw new Error(pick('会话文件一直在写入，没能安全改写会话头；会话没有移动', 'The session file kept changing, so its header was not rewritten; the session was not moved'))
}

export async function rewriteSessionCwd(file: string, cwd: string, lease?: SessionMoveLease): Promise<{ previousCwd?: string }> {
  const held = moveLocks.get(lockKey(file))
  if (held && (!lease || held !== lease.token)) {
    throw new Error(pick('这条会话正在移动，请稍后再试', 'This session is being moved; try again shortly'))
  }
  const own = held ? null : beginSessionMove(file)
  if (!held && !own) throw new Error(pick('这条会话正在移动，请稍后再试', 'This session is being moved; try again shortly'))
  try {
    return await rewriteOnce(file, cwd)
  } finally {
    own?.release()
  }
}

export async function restoreSessionHeaderCwd(file: string, cwd: string, lease?: SessionMoveLease): Promise<boolean> {
  try {
    await rewriteSessionCwd(file, cwd, lease)
    return true
  } catch {
    return false
  }
}
