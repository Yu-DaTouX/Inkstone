/**
 * 终端程序状态协议（OSC 7501，OSC 9;4 为后备）的纯解析与记录。
 *
 * 以随包 pi 1.2.0 的 `formatProgramStatus` / `isProgramStatusReply` 为准：pi 先发能力
 * 查询 `ESC ] 7501 ; ? ST`，终端回复 `ESC ] 7501 ; ? <payload> ST` 后，pi 才上报
 * `ESC ] 7501 ; state=...:app=...:kind=...:msg=<base64> ST`——首个 `7501` 与载荷之间
 * 是分号，字段之间是冒号，`msg` 是 2048 UTF-8 字节内截断后的 base64。这里只做旁路
 * 解析：数据照常原样交给 xterm，本模块只读状态，不改数据流。
 *
 * 序列跨块拼接；单条序列（含头与终止符）4096 字节上限，超限丢弃并在下一终止符处
 * 恢复扫描；7501 优先于 9;4；进程退出时丢弃 working / blocked；带 id 的子记录不驱动
 * 根记录。查询只认精确的 `7501;?`：带 payload 的同类帧（能力回复 / 详细回显）不当作
 * 新查询，避免自身回复被反射成无限查询。
 */
import type {
  TerminalBlockedKind,
  TerminalProgramState,
  TerminalProgramStatus
} from '../shared/ipc'

/** pi 查询帧体：只有这一种精确形态算查询 */
const PROGRAM_STATUS_QUERY_BODY = '7501;?'

/** pi 发出的能力查询帧完整形态（`ESC ] 7501 ; ? ST`），与 pi 源码 `PROGRAM_STATUS_QUERY` 同值 */
export const PI_PROGRAM_STATUS_QUERY = '\x1b]7501;?\x1b\\'

/**
 * 终端写回 PTY 的能力回复：`7501;?1`。
 *
 * 导出名沿用 pi 源码的 `PROGRAM_STATUS_QUERY`，因为 `src/main/terminal.ts` 的写入点引用
 * 该名字；在本模块里它的角色是「终端 → 程序」的能力回复。带最小 payload `1`：既被
 * pi 的 `isProgramStatusReply` 接受，又不会被 `isTerminalStatusQuery` 的精确匹配再当成
 * 查询（对端把回复回显出来也不会无限反射）。
 */
export const PROGRAM_STATUS_QUERY = '\x1b]7501;?1\x1b\\'

/** 能力回复的规范名，等于 `PROGRAM_STATUS_QUERY` */
export const PROGRAM_STATUS_REPLY = PROGRAM_STATUS_QUERY

/** 单条 OSC 序列的字节上限；超限整条丢弃 */
export const MAX_SEQUENCE_BYTES = 4096

/** `msg` 解码后的 UTF-8 字节上限，与 pi 的 `MAX_MESSAGE_BYTES` 一致 */
export const MAX_MESSAGE_BYTES = 2048

/** 展示用短标题上限（Unicode 码点） */
const MAX_TITLE_CHARS = 120

const PROGRAM_STATES: readonly TerminalProgramState[] = ['working', 'blocked', 'done', 'error', 'idle', 'clear']
const BLOCKED_KINDS: readonly TerminalBlockedKind[] = ['permission', 'question', 'auth']
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const DECIMAL_PATTERN = /^\d{1,3}$/
const LEGACY_STATE_PATTERN = /^[0-4]$/

/** 扫描器解析出的一条事件 */
export type TerminalStatusEvent =
  | { kind: 'query' }
  | { kind: 'report'; status: TerminalProgramStatus }
  | { kind: 'progress'; state: number; value?: number }

function isProgramState(value: string): value is TerminalProgramState {
  return (PROGRAM_STATES as readonly string[]).includes(value)
}

function isBlockedKind(value: string): value is TerminalBlockedKind {
  return (BLOCKED_KINDS as readonly string[]).includes(value)
}

/**
 * 严格解一条 base64 UTF-8 文本：非法字符、非规范填充、坏 UTF-8、控制字符都返回 null。
 * 解码不出内容（空串）返回空字符串，由调用方决定是否当没有标题。
 */
export function decodeStatusText(encoded: string): string | null {
  if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    return null
  }
  // Node 的 base64 解码较宽松：用重编码比对拒绝非规范输入（如错误填充 / 杂字符）
  if (bytes.toString('base64') !== encoded) return null
  // pi 的 formatter 保证 msg 在 2048 字节内；超出视为非规范帧整条丢弃
  if (bytes.length > MAX_MESSAGE_BYTES) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (CONTROL_CHARS.test(text)) return null
  // 按 Unicode 码点截断，避免把代理对从中间切断
  const codePoints = Array.from(text)
  return codePoints.length > MAX_TITLE_CHARS ? codePoints.slice(0, MAX_TITLE_CHARS).join('') : text
}

/** body 是去掉 `ESC ]` 与终止符之后的内容，例如 `7501;state=working:msg=...` */
export function isTerminalStatusQuery(body: string): boolean {
  // 只认精确查询；`7501;?1` 是能力回复 / 详细回显，不是新查询
  return body === PROGRAM_STATUS_QUERY_BODY
}

/**
 * 解析一条 7501 上报；不是 7501、字段不合法、状态不在协议内、base64 / 进度非法都返回 null。
 * 返回 `clear` 表示要求清掉记录（由调用方应用）。
 */
export function parseTerminalStatusReport(body: string): TerminalProgramStatus | null {
  if (!body.startsWith('7501;')) return null
  const payload = body.slice(5)
  if (payload.startsWith('?')) return null
  if (CONTROL_CHARS.test(payload)) return null

  const fields = new Map<string, string>()
  for (const pair of payload.split(':')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return null
    const key = pair.slice(0, eq)
    if (fields.has(key)) return null
    fields.set(key, pair.slice(eq + 1))
  }

  // 子记录（带 id）只描述程序内部的一条状态，不驱动根记录
  if (fields.has('id')) return null

  const state = fields.get('state')
  if (!state || !isProgramState(state)) return null
  const status: TerminalProgramStatus = { state }

  if (state === 'blocked') {
    const kind = fields.get('kind')
    if (kind !== undefined) {
      if (!isBlockedKind(kind)) return null
      status.kind = kind
    }
  }

  const progress = fields.get('progress')
  if (progress !== undefined) {
    if (!DECIMAL_PATTERN.test(progress)) return null
    const value = Number(progress)
    if (value > 100) return null
    status.progress = value
  }

  const app = fields.get('app')
  if (app !== undefined) {
    if (!APP_PATTERN.test(app)) return null
    status.app = app
  }

  const encodedTitle = fields.get('msg') ?? fields.get('title')
  if (encodedTitle !== undefined) {
    const title = decodeStatusText(encodedTitle)
    if (title === null) return null
    if (title) status.title = title
  }

  return status
}

/** 解析 OSC 9;4 进度：结构必须恰好 `9;4;<0-4>` 或 `9;4;<0-4>;<0-100>` */
export function parseLegacyProgress(body: string): { state: number; value?: number } | null {
  if (!body.startsWith('9;4;')) return null
  const parts = body.split(';')
  if (parts.length !== 3 && parts.length !== 4) return null
  if (!LEGACY_STATE_PATTERN.test(parts[2])) return null
  const state = Number(parts[2])
  if (parts.length === 3) return { state }
  if (!DECIMAL_PATTERN.test(parts[3])) return null
  const value = Number(parts[3])
  if (value > 100) return null
  return { state, value }
}

/**
 * 9;4 → 状态投影：0 清除、1 正常（可带进度）、2 错误、3 不确定、4 暂停。
 * 「暂停」不是「在等你」，映射成 idle，避免触发待确认提示。
 */
export function legacyProgressToStatus(progress: { state: number; value?: number }): TerminalProgramStatus | null {
  switch (progress.state) {
    case 0:
      return { state: 'clear' }
    case 1:
      return progress.value === undefined ? { state: 'working' } : { state: 'working', progress: progress.value }
    case 2:
      return { state: 'error' }
    case 3:
      return { state: 'working' }
    case 4:
      return { state: 'idle' }
    default:
      return null
  }
}

/** 两份投影是否等价（用于「只在变化时推送」） */
export function statusesEqual(a?: TerminalProgramStatus, b?: TerminalProgramStatus): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.state === b.state && a.kind === b.kind && a.progress === b.progress && a.title === b.title && a.app === b.app
}

/** 在 `s` 中从 `from` 起找 OSC 终止符（BEL 或 ST） */
function findOscEnd(s: string, from: number): { contentEnd: number; end: number; aborted: boolean } | null {
  for (let i = from; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code === 0x07) return { contentEnd: i, end: i + 1, aborted: false }
    if (code === 0x1b) {
      if (s.charCodeAt(i + 1) === 0x5c) return { contentEnd: i, end: i + 2, aborted: false }
      // 块尾的 ESC 可能是被切开的 ST：未收到反斜杠前不落状态
      if (i + 1 >= s.length) return null
      // 裸 ESC 或 ESC 后不是反斜杠：当前序列未终止，丢弃并回到下一个 OSC
      return { contentEnd: i, end: i, aborted: true }
    }
  }
  return null
}

/**
 * 逐会话的 OSC 扫描器：喂入输出块，吐出查询 / 7501 上报 / 9;4 后备。
 *
 * 不保存无关的普通输出，只保留可能跨块的一条不完整 OSC；超限时进入丢弃状态，
 * 在下一个终止符处恢复，不会把后续正常输出一直吃掉。
 */
export class TerminalStatusScanner {
  private pending = ''
  private discarding = false
  private saw7501 = false

  /** 该会话是否已收到过 7501（收到后 9;4 只当后备） */
  get programStatusSeen(): boolean {
    return this.saw7501
  }

  write(chunk: string): TerminalStatusEvent[] {
    if (!chunk) return []
    this.pending += chunk
    const events: TerminalStatusEvent[] = []

    for (;;) {
      if (this.discarding) {
        const end = this.findDiscardEnd()
        if (end < 0) {
          /* 只留可能是被切开的 ST 的末尾 ESC；其余丢弃内容不再保存 */
          this.pending = this.pending.endsWith('\x1b') ? '\x1b' : ''
          break
        }
        this.pending = this.pending.slice(end)
        this.discarding = false
        continue
      }

      const start = this.pending.indexOf('\x1b]')
      if (start < 0) {
        this.pending = this.pending.endsWith('\x1b') ? '\x1b' : ''
        break
      }
      const rest = this.pending.slice(start)
      const end = findOscEnd(rest, 2)
      if (!end) {
        if (Buffer.byteLength(rest, 'utf8') > MAX_SEQUENCE_BYTES) {
          /* 未终止且已超限：进入丢弃，只留末尾 ESC 以识别被切开的 ST */
          this.discarding = true
          this.pending = rest.endsWith('\x1b') ? '\x1b' : ''
        } else {
          this.pending = rest
        }
        break
      }

      // 完整帧（含头与终止符）与未终止帧受同一上限；超限则不消费，跳过终止符后继续
      if (Buffer.byteLength(rest.slice(0, end.end), 'utf8') > MAX_SEQUENCE_BYTES) {
        this.pending = rest.slice(end.end)
        continue
      }

      if (!end.aborted) {
        const event = this.consume(rest.slice(2, end.contentEnd))
        if (event) events.push(event)
      }
      this.pending = rest.slice(end.end)
    }

    return events
  }

  private consume(body: string): TerminalStatusEvent | null {
    if (body.startsWith('7501;')) {
      // 查询与上报都算「程序在用 7501」，此后 9;4 不再驱动记录
      this.saw7501 = true
      if (isTerminalStatusQuery(body)) return { kind: 'query' }
      const status = parseTerminalStatusReport(body)
      return status ? { kind: 'report', status } : null
    }
    if (body.startsWith('9;4;')) {
      if (this.saw7501) return null
      const progress = parseLegacyProgress(body)
      return progress ? { kind: 'progress', ...progress } : null
    }
    return null
  }

  private findDiscardEnd(): number {
    for (let i = 0; i < this.pending.length; i += 1) {
      const code = this.pending.charCodeAt(i)
      if (code === 0x07) return i + 1
      if (code === 0x1b && this.pending.charCodeAt(i + 1) === 0x5c) return i + 2
    }
    return -1
  }
}

/**
 * 一层薄记录：把扫描事件落成「当前状态」并回答「是否变化」。
 * 需要写回查询的次数也一并给出，终端侧据此回复程序。
 */
export class TerminalProgramStatusTracker {
  private readonly scanner = new TerminalStatusScanner()
  private current: TerminalProgramStatus | undefined

  get status(): TerminalProgramStatus | undefined {
    return this.current
  }

  get programStatusSeen(): boolean {
    return this.scanner.programStatusSeen
  }

  consume(chunk: string): { queries: number; changed: boolean } {
    let queries = 0
    let changed = false
    for (const event of this.scanner.write(chunk)) {
      if (event.kind === 'query') {
        queries += 1
        continue
      }
      const next = event.kind === 'report' ? event.status : legacyProgressToStatus(event)
      if (!next) continue
      if (next.state === 'clear') {
        if (this.current) {
          this.current = undefined
          changed = true
        }
        continue
      }
      if (!statusesEqual(this.current, next)) {
        this.current = next
        changed = true
      }
    }
    return { queries, changed }
  }

  /** 进程退出：丢弃 working / blocked，保留 done / error；返回是否变化 */
  exit(): boolean {
    if (this.current?.state !== 'working' && this.current?.state !== 'blocked') return false
    this.current = undefined
    return true
  }
}
