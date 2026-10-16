export interface FileResourceIdentity {
  projectId?: string | null
  workspaceRoot?: string | null
  canonicalPath: string
}

const SEP = '|'
const EMPTY = '-'

function encodePart(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v ? encodeURIComponent(v) : EMPTY
}

function decodePart(value: string): string | null {
  if (!value || value === EMPTY) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function fileResourceKey(identity: FileResourceIdentity): string {
  return [
    encodePart(identity.projectId),
    encodePart(identity.workspaceRoot),
    encodePart(identity.canonicalPath)
  ].join(SEP)
}

export function parseFileResourceKey(key: string): FileResourceIdentity | null {
  const parts = String(key ?? '').split(SEP)
  if (parts.length !== 3) return null
  const canonicalPath = decodePart(parts[2])
  if (!canonicalPath) return null
  return { projectId: decodePart(parts[0]), workspaceRoot: decodePart(parts[1]), canonicalPath }
}

export function fileResourceLabel(canonicalPath: string): string {
  const norm = String(canonicalPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

export function resolveRelativePath(baseDir: string, rel: string): string {
  if (/^(?:[A-Za-z]:|[\\/])/.test(String(rel ?? ''))) return ''
  const base = String(baseDir ?? '').replace(/[\\/]+$/, '')
  const segs = base.replace(/\\/g, '/').split('/')
  for (const raw of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      if (segs.length > 1) segs.pop()
      continue
    }
    segs.push(raw)
  }
  return segs.join('/')
}

export function sameResourcePath(a: string, b: string): boolean {
  return String(a ?? '').replace(/\\/g, '/') === String(b ?? '').replace(/\\/g, '/')
}
