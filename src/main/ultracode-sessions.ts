import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'

const STATE_FILE = join(YAN_DIR, 'ultracode-sessions.json')

function readAll(file: string): Record<string, true> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value === true)) as Record<string, true>
  } catch {
    return {}
  }
}

export function isUltracodeOn(sessionId: string | undefined, file = STATE_FILE): boolean {
  return !!sessionId && readAll(file)[sessionId] === true
}

export function setUltracodeOn(sessionId: string, on: boolean, file = STATE_FILE): void {
  const all = readAll(file)
  if (on) all[sessionId] = true
  else delete all[sessionId]
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all), 'utf8')
  renameSync(tmp, file)
}
