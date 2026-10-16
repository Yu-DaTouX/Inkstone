export const DEEPLINK_SCHEME = 'inkstone'

export const DEEPLINK_PREFIX = `${DEEPLINK_SCHEME}://`

export const MAX_DEEPLINK_URL_LENGTH = 8192

export const MAX_DEEPLINK_TEXT_LENGTH = 8000

export const MAX_DEEPLINK_ID_LENGTH = 200

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
  entryId?: string
}

export interface DeepLinkNewSession {
  action: 'new-session'
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
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function validateId(value: string): string | null {
  if (value.length > MAX_DEEPLINK_ID_LENGTH) return null
  if (!SAFE_ID.test(value)) return null
  if (value.includes('..')) return null
  return value
}

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

function singlePathSegment(pathname: string): string | null {
  if (!/^\/[^/]+$/.test(pathname)) return null
  return pathname.slice(1)
}

function fail(reason: DeepLinkRejectReason): DeepLinkParseResult {
  return { ok: false, reason }
}

export function parseDeepLink(raw: unknown): DeepLinkParseResult {
  if (typeof raw !== 'string') return fail('empty')
  const input = raw.trim()
  if (!input) return fail('empty')
  if (input.length > MAX_DEEPLINK_URL_LENGTH) return fail('too-long')
  if (CONTROL_CHARS.test(input)) return fail('control')
  if (!input.toLowerCase().startsWith(DEEPLINK_PREFIX)) return fail('scheme')

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return fail('malformed')
  }
  if (url.protocol !== `${DEEPLINK_SCHEME}:`) return fail('scheme')

  const host = url.hostname.toLowerCase()

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

export function firstDeepLinkArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    const value = arg.trim()
    if (value.toLowerCase().startsWith(`${DEEPLINK_SCHEME}:`)) return value
  }
  return null
}

export function parseDeepLinkFromArgv(argv: readonly string[]): DeepLinkParseResult | null {
  const arg = firstDeepLinkArg(argv)
  return arg === null ? null : parseDeepLink(arg)
}

export function parseDeepLinkFromOpenUrl(url: string): DeepLinkParseResult {
  return parseDeepLink(url)
}
