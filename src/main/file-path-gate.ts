import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { isNetworkPath } from '../shared/network-path'

export function foreignNetworkPath(target: string, root?: string | null): boolean {
  const network = isNetworkPath(target) || (isAbsolute(target) && isNetworkPath(resolve(target)))
  if (!network) return false
  if (!root || !/^[\\/]{2}(?![?.][\\/])/.test(root) || !/^[\\/]{2}(?![?.][\\/])/.test(target)) return true
  return !isWithin(resolve(root), resolve(target))
}

export async function networkPathBlocked(target: string, root?: string | null): Promise<boolean> {
  if (!foreignNetworkPath(target, root)) return false
  if (!root || !/^[\\/]{2}(?![?.][\\/])/.test(target)) return true
  const rootReal = await realpath(root).catch(() => null)
  return !rootReal || foreignNetworkPath(target, rootReal)
}

export function pathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = value.replace(/[\\/]+/g, '/').replace(/(.)\/$/, '$1')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const r = pathKey(root, platform).replace(/\/$/, '')
  const c = pathKey(candidate, platform).replace(/\/$/, '')
  return c === r || c.startsWith(r + '/')
}

export function isStrictlyWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  return isWithin(root, candidate, platform) && pathKey(root, platform).replace(/\/$/, '') !== pathKey(candidate, platform).replace(/\/$/, '')
}

export function lexicalJoin(root: string, rel: string): string | null {
  const base = resolve(root)
  const cleaned = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('\0')) return null
  if (cleaned.split('/').includes('..')) return null
  if (/^[A-Za-z]:/.test(cleaned)) return null
  const abs = resolve(join(base, cleaned))
  const boundary = base.endsWith(sep) ? base : base + sep
  if (abs !== base && !abs.startsWith(boundary)) return null
  return abs
}

export type ScopedPathFailure = 'invalid' | 'outside_root' | 'missing' | 'root_missing'

export type ScopedPathResult =
  | { ok: true; root: string; real: string; lexical: string }
  | { ok: false; reason: ScopedPathFailure; root: string; lexical: string; creatable?: boolean }

export async function realRoot(root: string): Promise<string | null> {
  try {
    const real = await realpath(root)
    return (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

async function parentCreatable(rootReal: string, lexical: string): Promise<boolean> {
  try {
    const parent = await realpath(dirname(lexical))
    if (!(await stat(parent)).isDirectory()) return false
    return isStrictlyWithin(rootReal, join(parent, basename(lexical)))
  } catch {
    return false
  }
}

export async function scopedPath(
  root: string,
  target: string,
  options: { allowAbsolute?: boolean } = {}
): Promise<ScopedPathResult> {
  const rootReal = await realRoot(root)
  const raw = String(target ?? '')
  if (!rootReal) return { ok: false, reason: 'root_missing', root: resolve(root), lexical: '' }
  if (raw.includes('\0')) return { ok: false, reason: 'invalid', root: rootReal, lexical: '' }
  let lexical: string | null
  if (isAbsolute(raw)) {
    if (!options.allowAbsolute || foreignNetworkPath(raw, rootReal)) return { ok: false, reason: 'invalid', root: rootReal, lexical: '' }
    lexical = resolve(raw)
  } else {
    lexical = lexicalJoin(rootReal, raw)
    if (!lexical) return { ok: false, reason: 'outside_root', root: rootReal, lexical: resolve(rootReal, raw) }
  }
  let real: string
  try {
    real = await realpath(lexical)
  } catch {
    if (!isWithin(rootReal, lexical)) return { ok: false, reason: 'outside_root', root: rootReal, lexical }
    return { ok: false, reason: 'missing', root: rootReal, lexical, creatable: await parentCreatable(rootReal, lexical) }
  }
  if (!isWithin(rootReal, real)) return { ok: false, reason: 'outside_root', root: rootReal, lexical }
  return { ok: true, root: rootReal, real, lexical }
}
