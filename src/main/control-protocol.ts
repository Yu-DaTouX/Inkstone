import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, lstat } from 'node:fs/promises'

export const CONTROL_ARG_PREFIX = '--yan-control='

export type ControlAction = 'status' | 'focus' | 'click' | 'type' | 'key' | 'send'

export interface ControlCommand {
  requestId: string
  action: ControlAction
  x?: number
  y?: number
  text?: string
  key?: string
}

export interface ControlResponse {
  ok: boolean
  action?: ControlAction
  data?: unknown
  error?: string
}

const CONTROL_ACTIONS: readonly ControlAction[] = ['status', 'focus', 'click', 'type', 'key', 'send']
const REQUEST_ID = /^[0-9a-f-]{16,80}$/i
const MAX_TEXT = 20_000

export function controlResponsePath(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error('Invalid control request identity')
  return join(tmpdir(), 'yan-control', `response-${requestId}.json`)
}

export function encodeControlCommand(command: ControlCommand): string {
  return `${CONTROL_ARG_PREFIX}${Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')}`
}

export function decodeControlCommand(argv: readonly string[]): ControlCommand | null {
  const arg = argv.find((value) => value.startsWith(CONTROL_ARG_PREFIX))
  if (!arg) return null

  try {
    const raw = JSON.parse(Buffer.from(arg.slice(CONTROL_ARG_PREFIX.length), 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const requestId = raw.requestId
    const action = raw.action
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null
    if (typeof action !== 'string' || !CONTROL_ACTIONS.includes(action as ControlAction)) return null

    const command: ControlCommand = { requestId, action: action as ControlAction }
    if (action === 'click') {
      if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
      command.x = Number(raw.x)
      command.y = Number(raw.y)
    }
    if (action === 'type' || action === 'send') {
      if (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT) return null
      command.text = raw.text
    }
    if (action === 'key') {
      if (typeof raw.key !== 'string' || raw.key.length === 0 || raw.key.length > 32) return null
      command.key = raw.key
    }
    return command
  } catch {
    return null
  }
}

export async function writeControlResponse(requestId: string, response: ControlResponse): Promise<void> {
  const path = controlResponsePath(requestId)
  const directory = join(tmpdir(), 'yan-control')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Unsafe control response directory')
  await writeFile(path, JSON.stringify(response), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}
