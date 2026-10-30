import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REAL_PI = process.env.YAN_DEBUG_USER_PI || join(homedir(), '.pi', 'agent')
const DATA_FILES = [
  'titles.json',
  'manual-titles.json',
  'session-layout.json',
  'session-chains.json',
  'compaction-lines.json',
  'usage-stats.json',
  'quota-samples.json',
  'spaces.json',
  'agent-profiles.json',
  'plugin-catalog.json',
  'work-modes.json',
  'goals.json',
  'artifact-docs.json'
]
const PI_FILES = ['left-panel.json']
const SECRET_KEYS = /^(apiKey|apiKeys|headers|token|accessToken|refreshToken|secret|password|authorization)$/i

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, item]) => [key, stripSecrets(item)]))
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function recentSessions(root, days, budgetBytes) {
  if (!existsSync(root)) return []
  const since = Date.now() - days * 86400000
  const files = []
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const stat = statSync(join(dir, name))
      if (stat.mtimeMs >= since) files.push({ bucket, name, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const kept = []
  let total = 0
  for (const file of files) {
    if (total + file.size > budgetBytes) continue
    total += file.size
    kept.push(file)
  }
  return kept
}

export function importUserData(box, { days = 7, budgetMb = 400 } = {}) {
  const realData = join(REAL_PI, 'yan')
  const sessions = recentSessions(join(REAL_PI, 'sessions'), days, budgetMb * 1048576)
  for (const file of sessions) {
    mkdirSync(join(box.sessionsDir, file.bucket), { recursive: true })
    cpSync(join(REAL_PI, 'sessions', file.bucket, file.name), join(box.sessionsDir, file.bucket, file.name))
  }
  for (const name of DATA_FILES) {
    if (existsSync(join(realData, name))) cpSync(join(realData, name), join(box.dataDir, name))
  }
  for (const name of PI_FILES) {
    if (existsSync(join(REAL_PI, name))) cpSync(join(REAL_PI, name), join(box.piDir, name))
  }
  const desktop = readJson(join(realData, 'desktop.json'))
  if (desktop) {
    const sandboxed = {
      ...stripSecrets(desktop),
      remoteAccess: { enabled: false, relay: { enabled: false } },
      fontUiCustom: undefined,
      lastMainModel: undefined,
      backgroundCustom: undefined,
      backgroundCustomLight: undefined
    }
    writeFileSync(join(box.dataDir, 'desktop.json'), JSON.stringify(sandboxed))
  }
  const models = readJson(join(REAL_PI, 'models.json'))
  const sandboxModels = readJson(join(box.piDir, 'models.json'))
  if (models?.providers) {
    const merged = { ...stripSecrets(models), providers: { ...stripSecrets(models.providers), ...(sandboxModels?.providers ?? {}) } }
    writeFileSync(join(box.piDir, 'models.json'), JSON.stringify(merged))
  }
  return { sessions: sessions.length, sessionMb: Math.round(sessions.reduce((sum, file) => sum + file.size, 0) / 1048576) }
}
