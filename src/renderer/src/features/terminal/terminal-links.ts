export interface TerminalUrlLink {
  kind: 'url'
  start: number
  end: number
  text: string
  url: string
}

export interface TerminalFileLink {
  kind: 'file'
  start: number
  end: number
  text: string
  path: string
  line?: number
  column?: number
}

export type TerminalLinkMatch = TerminalUrlLink | TerminalFileLink

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\u0000-\u001f\u007f-\uffff]+/g
const SEGMENT = "[\\w\\-.@+~$#%=\\u00c0-\\u2fff\\u3040-\\ufdff]+"
const PATH_PATTERN = new RegExp(
  `(?<![\\w.\\-/\\\\:@~$#%=])((?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?(?:${SEGMENT}[\\\\/])*${SEGMENT})` +
    `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:[,:]\\s?(\\d+))?\\)|"?,\\s*line\\s+(\\d+))?`,
  'g'
)
const EXTENSION = /\.[A-Za-z][A-Za-z0-9_-]{0,11}$/
const ROOTED = /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])/
const MAX_SCAN_CHARS = 4000

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.slice(-1)
    if (/[.,;:!?*]/.test(last)) {
      url = url.slice(0, -1)
      continue
    }
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    const open = pairs[last]
    if (open) {
      const opens = url.split(open).length - 1
      const closes = url.split(last).length - 1
      if (closes > opens) {
        url = url.slice(0, -1)
        continue
      }
    }
    return url
  }
}

function positive(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function acceptablePath(path: string, line: number | undefined): boolean {
  if (path.length < 2) return false
  const separated = /[\\/]/.test(path)
  const last = path.split(/[\\/]/).pop() ?? ''
  if (!last || /^\.+$/.test(last)) return false
  if (EXTENSION.test(last)) return true
  if (!separated) return false
  if (ROOTED.test(path) && /[A-Za-z]/.test(last)) return true
  return line !== undefined && /[A-Za-z]/.test(last)
}

export function findTerminalUrls(text: string): TerminalUrlLink[] {
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const links: TerminalUrlLink[] = []
  for (const match of scan.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0])
    if (url.length <= match[0].indexOf('//') + 2) continue
    const start = match.index ?? 0
    links.push({ kind: 'url', start, end: start + url.length, text: url, url })
  }
  return links
}

export function findTerminalFiles(text: string): TerminalFileLink[] {
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const links: TerminalFileLink[] = []
  for (const match of scan.matchAll(PATH_PATTERN)) {
    const start = match.index ?? 0
    let path = match[1]
    const line = positive(match[2] ?? match[4] ?? match[6])
    const column = positive(match[3] ?? match[5])
    const suffix = match[0].slice(match[1].length)
    if (!suffix) path = path.replace(/\.+$/, '')
    if (!acceptablePath(path, line)) continue
    const end = suffix ? start + match[0].length : start + path.length
    links.push({
      kind: 'file',
      start,
      end,
      text: scan.slice(start, end),
      path,
      ...(line !== undefined ? { line } : {}),
      ...(line !== undefined && column !== undefined ? { column } : {})
    })
  }
  return links
}

export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const urls = findTerminalUrls(text)
  const files = findTerminalFiles(text).filter(
    (file) => !urls.some((url) => file.start < url.end && url.start < file.end)
  )
  return [...urls, ...files].sort((a, b) => a.start - b.start)
}

function windowsStyle(cwd: string): boolean {
  return /^[A-Za-z]:/.test(cwd) || (cwd.includes('\\') && !cwd.includes('/'))
}

export function resolveTerminalPath(cwd: string, raw: string): string | null {
  const path = raw.trim()
  if (!path || path.includes('\0')) return null
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  const windows = windowsStyle(cwd)
  if (path.startsWith('/') || path.startsWith('\\')) {
    if (!windows) return path
    const drive = /^\/([A-Za-z])\/(.*)$/.exec(path)
    return drive ? `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}` : path
  }
  const root = cwd.trim().replace(/[\\/]+$/, '')
  if (!root) return null
  const sep = windows ? '\\' : '/'
  const relative = path.replace(/^\.[\\/]+/, '').replace(/[\\/]+/g, sep)
  return `${root}${sep}${relative}`
}

export function isTerminalLinkGesture(event: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
}

export function selectionFence(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function terminalSelectionBlock(selection: string, source: string): string {
  const body = selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
  if (!body) return ''
  const fence = selectionFence(body)
  return `${source}\n${fence}text\n${body}\n${fence}`
}
