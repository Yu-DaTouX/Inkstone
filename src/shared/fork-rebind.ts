export type ForkRefState = 'resolved' | 'missing' | 'type-mismatch' | 'outside'

export interface ForkRefResolution {
  ref: string
  state: ForkRefState
  abs: string | null
  kind: 'file' | 'dir' | null
}

export interface ForkRefSummary {
  total: number
  resolved: number
  missing: number
  mismatch: number
  outside: number
  problems: ForkRefResolution[]
}

export function normalizeSlashes(p: string): string {
  return p.replace(/\\+/g, '/').replace(/\/+$/, '')
}

const lower = (p: string): string => normalizeSlashes(p).toLowerCase()

export function isAbsolutePath(p: string): boolean {
  const n = normalizeSlashes(p)
  return /^[a-zA-Z]:\//.test(n) || n.startsWith('/')
}

export function hasDotDot(ref: string): boolean {
  return normalizeSlashes(ref)
    .split('/')
    .some((seg) => seg === '..')
}

export function toRepoRelative(repoRoot: string, abs: string): string | null {
  const root = normalizeSlashes(repoRoot)
  const target = normalizeSlashes(abs)
  const r = lower(root)
  const t = lower(target)
  if (t === r) return null
  if (!t.startsWith(r + '/')) return null
  return target.slice(root.length + 1)
}

export function resolveForkRefs(
  repoRoot: string,
  refs: readonly string[],
  stat: (abs: string) => 'file' | 'dir' | null
): ForkRefResolution[] {
  const base = normalizeSlashes(repoRoot)
  const seen = new Set<string>()
  const out: ForkRefResolution[] = []
  for (const item of refs) {
    const raw = String(item ?? '').trim().replace(/^\.\//, '')
    if (!raw) continue
    const wantDir = /[\\/]$/.test(raw)
    let ref = normalizeSlashes(raw)
    if (hasDotDot(raw)) {
      out.push({ ref: normalizeSlashes(raw), state: 'outside', abs: null, kind: null })
      continue
    }
    if (isAbsolutePath(raw)) {
      const converted = toRepoRelative(base, raw)
      if (!converted) {
        out.push({ ref: normalizeSlashes(raw), state: 'outside', abs: null, kind: null })
        continue
      }
      ref = converted
    }
    if (seen.has(ref.toLowerCase())) continue
    seen.add(ref.toLowerCase())
    const abs = `${base}/${ref}`
    const kind = stat(abs)
    if (!kind) {
      out.push({ ref, state: 'missing', abs, kind: null })
      continue
    }
    out.push({ ref, state: wantDir && kind === 'file' ? 'type-mismatch' : 'resolved', abs, kind })
  }
  return out
}

export function summarizeForkRefs(list: readonly ForkRefResolution[]): ForkRefSummary {
  const summary: ForkRefSummary = { total: list.length, resolved: 0, missing: 0, mismatch: 0, outside: 0, problems: [] }
  for (const item of list) {
    if (item.state === 'resolved') summary.resolved += 1
    else if (item.state === 'missing') {
      summary.missing += 1
      summary.problems.push(item)
    } else if (item.state === 'type-mismatch') {
      summary.mismatch += 1
      summary.problems.push(item)
    } else {
      summary.outside += 1
      summary.problems.push(item)
    }
  }
  return summary
}

const AT_REF = /(?:^|[\s(（【[])[@＠]([^\s@＠,，。；;、)）\]】'"]+)/g

export function extractRefsFromTexts(
  texts: readonly string[],
  isRepoFile: (rel: string) => boolean
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue
    AT_REF.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = AT_REF.exec(text))) {
      const ref = m[1].replace(/[.,;:]+$/, '')
      if (!ref || isAbsolutePath(ref) || hasDotDot(ref)) continue
      if (/^https?:/i.test(ref)) continue
      if (!isRepoFile(ref)) continue
      const key = ref.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}
