import { readFile, rename, mkdir, realpath, stat, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, isAbsolute } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { projectTrustedFrom } from './compaction'

export const TRUST_FILE_NAME = 'trust.json'

export interface TrustStatus {
  cwd: string
  trusted: boolean
  entry: string | null
}

async function readTable(): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(PI_AGENT_DIR, TRUST_FILE_NAME), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目信任文件格式无效，已拒绝覆盖')
    return raw as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

const norm = (p: string): string => {
  const path = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export async function trustStatus(cwd: string): Promise<TrustStatus> {
  const abs = resolve(cwd)
  const table = await readTable()
  if (!projectTrustedFrom(table, abs)) {
    let cur = norm(abs)
    for (;;) {
      const hit = Object.keys(table).find((k) => norm(k) === cur)
      if (hit) return { cwd: abs, trusted: false, entry: hit }
      const idx = cur.lastIndexOf('/')
      if (idx <= 0) break
      cur = cur.slice(0, idx)
    }
    return { cwd: abs, trusted: false, entry: null }
  }
  let cur = norm(abs)
  for (;;) {
    const hit = Object.keys(table).find((k) => norm(k) === cur)
    if (hit) return { cwd: abs, trusted: true, entry: hit }
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) return { cwd: abs, trusted: true, entry: null }
    cur = cur.slice(0, idx)
  }
}

let writeTail: Promise<unknown> = Promise.resolve()
function setTrust(cwd: string, trusted: boolean): Promise<{ ok: boolean; entry: string; error?: string }> {
  const operation = async () => {
    let temp: string | undefined
    try {
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('必须提供绝对目录')
      const abs = await realpath(cwd)
      if (!(await stat(abs)).isDirectory()) throw new Error('不是目录')
      const table = await readTable()
      const key = Object.keys(table).find((name) => norm(name) === norm(abs)) ?? abs
      table[key] = trusted
      await mkdir(PI_AGENT_DIR, { recursive: true })
      const file = join(PI_AGENT_DIR, TRUST_FILE_NAME)
      temp = `${file}.${randomUUID()}.tmp`
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(table, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temp, file)
      return { ok: true, entry: key }
    } catch (error) {
      if (temp) await unlink(temp).catch(() => undefined)
      return { ok: false, entry: '', error: error instanceof Error ? error.message : String(error) }
    }
  }
  const result = writeTail.then(operation, operation)
  writeTail = result.catch(() => undefined)
  return result
}
export function allowTrust(cwd: string): Promise<{ ok: boolean; entry: string; error?: string }> {
  return setTrust(cwd, true)
}
export function revokeTrust(cwd: string): Promise<{ ok: boolean; entry: string; error?: string }> {
  return setTrust(cwd, false)
}
