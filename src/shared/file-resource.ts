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

export function fileResourceKey(identity: FileResourceIdentity): string {
  return [
    encodePart(identity.projectId),
    encodePart(identity.workspaceRoot),
    encodePart(identity.canonicalPath)
  ].join(SEP)
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
