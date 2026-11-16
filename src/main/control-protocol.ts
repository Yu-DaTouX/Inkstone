import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, lstat } from 'node:fs/promises'
import type { BrowserWindow, WebContents } from 'electron'
import { pick } from '../shared/ui-lang'

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

export type ControlWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'getContentSize' | 'getTitle' | 'isVisible' | 'isMinimized' | 'isFocused' | 'getBounds'
> & { webContents: Pick<WebContents, 'sendInputEvent' | 'insertText'> }

export interface ControlPort {
  window(): ControlWindow | null
  showWindow(): void
  agentRunning(): boolean
  inputBlocked(): boolean
  sendToActive(text: string): Promise<{ ok: boolean; error?: string }>
}

const CONTROL_KEYS: Readonly<Record<string, string>> = {
  esc: 'ESC',
  escape: 'ESC',
  enter: 'RETURN',
  return: 'RETURN',
  tab: 'TAB',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  up: 'UP',
  arrowup: 'UP',
  down: 'DOWN',
  arrowdown: 'DOWN',
  left: 'LEFT',
  arrowleft: 'LEFT',
  right: 'RIGHT',
  arrowright: 'RIGHT',
  space: 'SPACE'
}

export function createControlExecutor(port: ControlPort): (command: ControlCommand) => Promise<ControlResponse> {
  const controlStatus = (): Record<string, unknown> => {
    const win = port.window()
    if (!win || win.isDestroyed()) {
      return { ready: false, agentRunning: port.agentRunning() }
    }
    const [contentWidth, contentHeight] = win.getContentSize()
    return {
      ready: true,
      title: win.getTitle(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
      bounds: win.getBounds(),
      contentSize: { width: contentWidth, height: contentHeight },
      agentRunning: port.agentRunning()
    }
  }

  return async (command) => {
    try {
      if (command.action === 'status') {
        return { ok: true, action: command.action, data: controlStatus() }
      }

      const win = port.window()
      if (!win || win.isDestroyed()) {
        return { ok: false, action: command.action, error: pick('砚主窗口尚未就绪', 'Main window is not ready') }
      }

      if (command.action === 'focus') {
        port.showWindow()
        return { ok: true, action: command.action, data: controlStatus() }
      }

      if ((command.action === 'click' || command.action === 'type' || command.action === 'key') && port.inputBlocked()) {
        return { ok: false, action: command.action, error: pick('有待处理的审批时不接受遥控输入，请在砚窗口里手动处理审批', 'Remote input is blocked while an approval is pending; handle it in the window') }
      }

      if (command.action === 'click') {
        const [width, height] = win.getContentSize()
        const x = command.x ?? -1
        const y = command.y ?? -1
        if (x < 0 || y < 0 || x >= width || y >= height) {
          return { ok: false, action: command.action, error: pick(`坐标超出内容区域：${width}×${height}`, `Coordinates outside the content area: ${width}×${height}`) }
        }
        port.showWindow()
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return { ok: true, action: command.action, data: { x, y } }
      }

      if (command.action === 'type') {
        port.showWindow()
        await win.webContents.insertText(command.text ?? '')
        return { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
      }

      if (command.action === 'key') {
        const keyCode = CONTROL_KEYS[(command.key ?? '').toLowerCase()]
        if (!keyCode) return { ok: false, action: command.action, error: pick('只支持受限导航键', 'Only restricted navigation keys are supported') }
        port.showWindow()
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
        return { ok: true, action: command.action, data: { key: command.key } }
      }

      if (command.action === 'send') {
        port.showWindow()
        const result = await port.sendToActive(command.text ?? '')
        return result.ok
          ? { ok: true, action: command.action, data: { length: command.text?.length ?? 0 } }
          : { ok: false, action: command.action, error: result.error }
      }

      return { ok: false, action: command.action, error: pick('未知控制动作', 'Unknown control action') }
    } catch (error) {
      return {
        ok: false,
        action: command.action,
        error: error instanceof Error ? error.message : String(error)
      }
    }
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
