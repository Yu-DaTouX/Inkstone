/**
 * `inkstone://` 深链接的纯解析与校验。
 *
 * 深链接是**进程外的输入面**：Windows 从第二个实例的 argv、macOS 从
 * `open-url` 事件进来，内容完全由外部决定。这一层只做一件事 —— 把原始
 * 字符串收敛成「白名单导航意图」，识别不出来或越界的一律拒绝，绝不透传
 * 原始 URL，也绝不在这里执行任何动作（动作永远由界面发起，见 02 §6.3）。
 *
 * 本模块不依赖 Electron / DOM / 文件系统，可单独单测；注册协议与实际转发
 * 分别在 `register.ts`、`service.ts`，主进程入口只做接线。
 *
 * 支持的动作（工单 WP-20c）：
 *   · `inkstone://session/<id>[?entry=<entryId>]`  打开会话
 *   · `inkstone://new[?text=<urlencoded>]`         新建会话并预填文本（不自动发送）
 *   · `inkstone://settings[/<section>]`            打开设置分区
 *   · `inkstone://runs`                            打开运行总览
 * 其余动作（含旧 `inkstone://pair`、`file:`、`javascript:` 等）不在白名单，
 * 返回拒绝原因，调用方只负责显示窗口，不做导航。
 */

/** URL scheme（不带冒号），与 electron-builder `protocols` 配置一致。 */
export const DEEPLINK_SCHEME = 'inkstone'

/** 只接受规范的 `inkstone://` 形式；`inkstone:xxx`（无 `//`）视作非法。 */
export const DEEPLINK_PREFIX = `${DEEPLINK_SCHEME}://`

/** 整条 URL 的长度上限；命令行与事件里的异常长串直接拒绝。 */
export const MAX_DEEPLINK_URL_LENGTH = 8192

/** 预填文本长度上限（按解码后的字符数计）。 */
export const MAX_DEEPLINK_TEXT_LENGTH = 8000

/** 会话 / entry 标识的长度上界。 */
export const MAX_DEEPLINK_ID_LENGTH = 200

/**
 * 允许的设置分区。与渲染端 `features/settings/types.ts` 的
 * `SettingsSectionId` 一致；新分区落地时两边同步。
 */
export const DEEPLINK_SETTINGS_SECTIONS = [
  'appearance',
  'context',
  'models',
  'capabilities',
  'usage',
  'shortcuts'
] as const

export type DeepLinkSettingsSection = (typeof DEEPLINK_SETTINGS_SECTIONS)[number]

export interface DeepLinkSession {
  action: 'session'
  sessionId: string
  /** 设计里的 `?entry=<entryId>`；仅校验并转发，定位能力由渲染端决定。 */
  entryId?: string
}

export interface DeepLinkNewSession {
  action: 'new-session'
  /** 已解码的预填文本；渲染端只写进输入框，绝不自动发送。 */
  text?: string
}

export interface DeepLinkSettings {
  action: 'settings'
  section: DeepLinkSettingsSection
}

export interface DeepLinkRuns {
  action: 'runs'
}

export type DeepLinkAction = DeepLinkSession['action'] | DeepLinkNewSession['action'] | DeepLinkSettings['action'] | DeepLinkRuns['action']

export type DeepLink = DeepLinkSession | DeepLinkNewSession | DeepLinkSettings | DeepLinkRuns

export type DeepLinkRejectReason =
  | 'empty'
  | 'too-long'
  | 'control'
  | 'malformed'
  | 'scheme'
  | 'action'
  | 'path'
  | 'id'
  | 'section'
  | 'text'

export type DeepLinkParseResult = { ok: true; link: DeepLink } | { ok: false; reason: DeepLinkRejectReason }

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** 标识只允许 URL 安全字符；不允许 `/`、`\`、`%`、空格，杜绝路径再解释。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function validateId(value: string): string | null {
  if (value.length > MAX_DEEPLINK_ID_LENGTH) return null
  if (!SAFE_ID.test(value)) return null
  /* `..` 即便通过字符集也不当标识（防解析器把它当路径段）。 */
  if (value.includes('..')) return null
  return value
}

/** 路径段还没解码；`URLSearchParams` 的查询值已经解码过，直接用 `validateId`。 */
function decodeId(raw: string): string | null {
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    return null
  }
  return validateId(value)
}

function isSettingsSection(value: string): value is DeepLinkSettingsSection {
  return (DEEPLINK_SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** 单段路径：`/abc`；多段、空段、编码斜杠都在这里拦掉。 */
function singlePathSegment(pathname: string): string | null {
  if (!/^\/[^/]+$/.test(pathname)) return null
  return pathname.slice(1)
}

function fail(reason: DeepLinkRejectReason): DeepLinkParseResult {
  return { ok: false, reason }
}

/**
 * 解析一条 `inkstone://` URL。
 *
 * 只认识的 scheme + 白名单 host 才继续；其余一律返回拒绝原因。`new` 的文本
 * 已在 URL 里解码，仍要再过长度与 NUL 检查 —— 渲染端拿到的始终是有界文本。
 */
export function parseDeepLink(raw: unknown): DeepLinkParseResult {
  if (typeof raw !== 'string') return fail('empty')
  const input = raw.trim()
  if (!input) return fail('empty')
  if (input.length > MAX_DEEPLINK_URL_LENGTH) return fail('too-long')
  if (CONTROL_CHARS.test(input)) return fail('control')
  /* 先做 scheme 字面判定：`new URL` 会把 `inkstone:session/x` 也认成 inkstone，
     但那不是设计里的规范形式，这里一律拒绝。 */
  if (!input.toLowerCase().startsWith(DEEPLINK_PREFIX)) return fail('scheme')

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return fail('malformed')
  }
  if (url.protocol !== `${DEEPLINK_SCHEME}:`) return fail('scheme')

  const host = url.hostname.toLowerCase()
  /* hash 不参与导航（渲染端自己管路由）；多余查询除白名单参数外忽略。 */

  switch (host) {
    case 'session': {
      const segment = singlePathSegment(url.pathname)
      if (!segment) return fail('id')
      const sessionId = decodeId(segment)
      if (!sessionId) return fail('id')
      const link: DeepLinkSession = { action: 'session', sessionId }
      const entry = url.searchParams.get('entry')
      if (entry !== null) {
        const entryId = validateId(entry)
        if (!entryId) return fail('id')
        link.entryId = entryId
      }
      return { ok: true, link }
    }

    case 'new': {
      if (url.pathname !== '' && url.pathname !== '/') return fail('path')
      const link: DeepLinkNewSession = { action: 'new-session' }
      const text = url.searchParams.get('text')
      if (text !== null) {
        if (text.length > MAX_DEEPLINK_TEXT_LENGTH) return fail('text')
        if (text.includes('\u0000')) return fail('text')
        if (text.length > 0) link.text = text
      }
      return { ok: true, link }
    }

    case 'settings': {
      let section = ''
      if (url.pathname !== '' && url.pathname !== '/') {
        const segment = singlePathSegment(url.pathname)
        if (!segment) return fail('section')
        section = decodeId(segment) ?? ''
        if (!section) return fail('section')
      } else {
        section = url.searchParams.get('section') ?? ''
      }
      if (!section) return { ok: true, link: { action: 'settings', section: 'appearance' } }
      if (!isSettingsSection(section)) return fail('section')
      return { ok: true, link: { action: 'settings', section } }
    }

    case 'runs': {
      if (url.pathname !== '' && url.pathname !== '/') return fail('path')
      return { ok: true, link: { action: 'runs' } }
    }

    default:
      return fail('action')
  }
}

/**
 * 从命令行参数里取出第一条 `inkstone://`。
 *
 * `second-instance`（Windows/Linux）与启动时的 `process.argv` 都走这里。
 * 返回原样字符串，校验交给 `parseDeepLink`。
 */
export function firstDeepLinkArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    const value = arg.trim()
    if (value.toLowerCase().startsWith(`${DEEPLINK_SCHEME}:`)) return value
  }
  return null
}

/** argv 里的深链接解析结果；没有候选参数时返回 null（与「解析失败」区分）。 */
export function parseDeepLinkFromArgv(argv: readonly string[]): DeepLinkParseResult | null {
  const arg = firstDeepLinkArg(argv)
  return arg === null ? null : parseDeepLink(arg)
}

/** macOS `open-url` 事件给的是单条 URL 字符串。 */
export function parseDeepLinkFromOpenUrl(url: string): DeepLinkParseResult {
  return parseDeepLink(url)
}
