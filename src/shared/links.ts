/*
 * The local-destination parser below is adapted from DeepSeek Harness
 * packages/client/ui-primitives/src/markdown/file-link.ts at commit
 * ddefc45fbc. DeepSeek Harness is MIT-licensed; see LICENSE and the
 * implementation plan for the source/attribution boundary.
 */

export type LinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line?: number; lineEnd?: number }
  | { kind: 'invalid'; reason: 'empty' | 'protocol' }

export function parseFileLink(
  value: string
): { path: string; line?: number; lineEnd?: number } | undefined {
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch (_error) {
    return undefined
  }
  if (path.length === 0 || /[\u0000-\u001f\u007f]/.test(path)
    || /^[\\/]{2}/.test(path)
    || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return undefined
  if (hash < 0) return { path }
  const fragment = value.slice(hash + 1)
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(fragment)
  if (match === null) return undefined
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return undefined
  return { path, line, ...(end > line ? { lineEnd: end } : {}) }
}

const BLOCKED_SCHEMES = new Set(['javascript', 'vbscript', 'data', 'blob'])

const EXTERNAL_SCHEMES = new Set(['mailto', 'tel'])

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

const LINE_RE = /^(.*?):(\d+)(?::(\d+))?$/

function isWindowsAbs(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p)
}
function isUncAbs(p: string): boolean {
  return /^\\\\[^\\]/.test(p)
}
function isUnixAbs(p: string): boolean {
  return p.startsWith('/')
}

function splitLine(raw: string): { path: string; line?: number } {
  const m = LINE_RE.exec(raw)
  if (!m) return { path: raw }
  const base = m[1]
  if (!base) return { path: raw }
  if (/^[a-zA-Z]$/.test(base)) return { path: raw }
  const line = Number(m[2])
  return Number.isFinite(line) && line > 0 ? { path: base, line } : { path: raw }
}

function fileUrlToPath(raw: string): string {
  let rest = raw.slice('file://'.length)
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

function decodeLocalPath(raw: string): string {
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function classifyLink(href: string | undefined | null): LinkTarget {
  const raw = (href ?? '').trim()
  if (!raw) return { kind: 'invalid', reason: 'empty' }
  if (raw.includes('\0')) return { kind: 'invalid', reason: 'protocol' }

  if (raw.includes('#')) {
    const parsed = parseFileLink(raw)
    if (parsed) return { kind: 'file', ...parsed }
  }

  const local = decodeLocalPath(raw)
  if (local.includes('\0')) return { kind: 'invalid', reason: 'protocol' }

  if (isWindowsAbs(local) || isUncAbs(local)) {
    const { path, line } = splitLine(local)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  const scheme = SCHEME_RE.exec(raw)?.[1]?.toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'url', url: raw }
    if (scheme === 'file') {
      const parsed = parseFileLink(raw.slice('file://'.length))
      if (parsed) {
        const path = /^\/[a-zA-Z]:[\\/]/.test(parsed.path) ? parsed.path.slice(1) : parsed.path
        return {
          kind: 'file',
          path,
          ...(parsed.line ? { line: parsed.line } : {}),
          ...(parsed.lineEnd ? { lineEnd: parsed.lineEnd } : {})
        }
      }
      const { path, line } = splitLine(fileUrlToPath(raw))
      return { kind: 'file', path, ...(line ? { line } : {}) }
    }
    if (EXTERNAL_SCHEMES.has(scheme)) return { kind: 'url', url: raw }
    if (BLOCKED_SCHEMES.has(scheme)) return { kind: 'invalid', reason: 'protocol' }
    return { kind: 'invalid', reason: 'protocol' }
  }

  if (isUnixAbs(local)) {
    const { path, line } = splitLine(local)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  if (local.includes('/') || local.includes('\\') || /\.[a-zA-Z0-9]{1,8}$/.test(local)) {
    const { path, line } = splitLine(local)
    return { kind: 'file', path, ...(line ? { line } : {}) }
  }

  return { kind: 'invalid', reason: 'empty' }
}
