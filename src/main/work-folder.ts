import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WORK_FOLDER_ROOT_NAME = 'Inkstone'
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function workFolderRoot(): string {
  return join(homedir(), WORK_FOLDER_ROOT_NAME)
}

export function sanitizeWorkFolderName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const cleaned = [...value]
    .filter((char) => char.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(char))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 64)
  if (!cleaned || /^\.+$/.test(cleaned) || RESERVED_NAMES.test(cleaned)) return ''
  return cleaned
}

export function createWorkFolder(name: unknown): { ok: boolean; cwd?: string; error?: string } {
  const base = sanitizeWorkFolderName(name)
  if (!base) return { ok: false, error: 'invalid-name' }
  const root = workFolderRoot()
  try {
    mkdirSync(root, { recursive: true })
    let target = join(root, base)
    for (let index = 2; existsSync(target); index++) target = join(root, `${base} ${index}`)
    mkdirSync(target)
    return { ok: true, cwd: target }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
