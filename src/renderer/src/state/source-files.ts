export const SOURCE_FILES_KEY = 'yan.source-files.v1'
const MAX_RECORDS = 200

export interface SourceFileRecord {
  path: string
  name: string
  addedAt: number
  sessionId: string
}

function isRecord(value: unknown): value is SourceFileRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SourceFileRecord>
  return (
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0
  )
}

function write(records: SourceFileRecord[]): void {
  try {
    localStorage.setItem(SOURCE_FILES_KEY, JSON.stringify(records.slice(-MAX_RECORDS)))
  } catch {
  }
}

export function readSourceFiles(): SourceFileRecord[] {
  try {
    const raw = localStorage.getItem(SOURCE_FILES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

export function addSourceFiles(sessionId: string, paths: string[]): void {
  if (!sessionId || !paths.length) return
  const all = readSourceFiles()
  const mine = all.filter((record) => record.sessionId === sessionId)
  const others = all.filter((record) => record.sessionId !== sessionId)
  for (const path of paths) {
    if (!path || mine.some((record) => record.path === path)) continue
    mine.push({ path, name: path.split(/[\\/]/).pop() ?? path, addedAt: Date.now(), sessionId })
  }
  write([...others, ...mine].sort((a, b) => a.addedAt - b.addedAt))
}

