import { homedir } from 'node:os'
import { dirname, parse, resolve, sep } from 'node:path'

const SYSTEM_TOP = ['windows', 'program files', 'program files (x86)', 'programdata']
const UNIX_BROAD = ['/system', '/usr', '/etc', '/bin', '/sbin', '/var', '/library', '/applications', '/opt', '/private']
const APPDATA_DEPTH = 3

function key(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '').toLowerCase()
}

function segments(path: string, root: string): string[] {
  return path.slice(root.length).split(/[\\/]+/).filter(Boolean)
}

export function isBroadAllowRoot(dir: string, home: string = homedir()): boolean {
  const target = resolve(dir)
  const root = key(parse(target).root)
  const t = key(target)
  if (t === root) return true
  const h = key(home)
  if (t === h || h.startsWith(`${t}${sep}`) || h.startsWith(`${t}/`)) return true
  if (dirname(t) === key(dirname(home))) return true
  const top = segments(t, root)[0] ?? ''
  if (SYSTEM_TOP.includes(top)) return true
  if (UNIX_BROAD.some((base) => t === base || t.startsWith(`${base}/`))) return true
  if (t.startsWith(`${h}${sep}`) || t.startsWith(`${h}/`)) {
    const inHome = segments(t, h)
    if (inHome[0]?.startsWith('.')) return true
    if (inHome[0] === 'appdata' && inHome.length <= APPDATA_DEPTH) return true
  }
  return false
}
