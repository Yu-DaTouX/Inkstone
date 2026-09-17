import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'

/**
 * 本机控制桥使用的单实例参数。
 *
 * 不开 Electron remote-debugging-port：控制请求由第二个 Electron 启动请求
 * 带进已有实例的 `second-instance` 事件，避免给主窗口暴露一个调试端口。
 */
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

/** 响应只落在临时目录，不能由请求参数指定任意写入路径。 */
export function controlResponsePath(requestId: string): string {
  return join(tmpdir(), 'yan-control', `response-${requestId}.json`)
}

/** 把控制请求编码进第二实例的 argv；值本身不含可解释的 shell 语法。 */
export function encodeControlCommand(command: ControlCommand): string {
  return `${CONTROL_ARG_PREFIX}${Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')}`
}

/**
 * 只接受本模块定义的字段和范围。
 *
 * 这是进程边界的第一层过滤；真正的输入动作还会在 index.ts 再做窗口/按键
 * 校验。解析失败时返回 null，让普通的第二次启动仍按原来的“显示并聚焦”处理。
 */
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
  await mkdir(join(tmpdir(), 'yan-control'), { recursive: true })
  await writeFile(path, JSON.stringify(response), 'utf8')
}
