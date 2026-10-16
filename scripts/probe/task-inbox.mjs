import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = process.env.YAN_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions')

function walk(p, acc = { files: 0, bytes: 0, newest: 0 }) {
  let entries = []
  try {
    entries = readdirSync(p, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = join(p, e.name)
    if (e.isDirectory()) walk(full, acc)
    else {
      try {
        const st = statSync(full)
        acc.files++
        acc.bytes += st.size
        if (st.mtimeMs > acc.newest) acc.newest = st.mtimeMs
      } catch {
      }
    }
  }
  return acc
}

const t0 = Date.now()
const stat = walk(dir)
const walkMs = Date.now() - t0

let listed = 0
let listMs = -1
let listError = null
try {
  const t1 = Date.now()
  const { listSessions } = await import('../../out/main/sessions.js')
  const sessions = await listSessions()
  listed = Array.isArray(sessions) ? sessions.length : -1
  listMs = Date.now() - t1
} catch (e) {
  listError = e instanceof Error ? e.message : String(e)
}

console.log(JSON.stringify({
  sessionsDir: dir,
  files: stat.files,
  megabytes: +(stat.bytes / 1024 / 1024).toFixed(1),
  newestActivity: stat.newest ? new Date(stat.newest).toISOString() : null,
  walkMs,
  listedSessions: listed,
  listSessionsMs: listMs,
  listError
}, null, 2))
