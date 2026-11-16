import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pick } from '../shared/ui-lang'
import { YAN_DIR } from './paths'
import { atomicWriteFile } from './atomic-write'
import { readPersistedJson } from './persisted-document'

const STATE_FILE = join(YAN_DIR, 'ultracode-sessions.json')

type State = Record<string, true>

function parseState(raw: unknown): State {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(pick('ultracode-sessions.json 不是 JSON 对象，已拒绝覆盖', 'ultracode-sessions.json is not a JSON object. Refusing to overwrite'))
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value === true)) as State
}

function readAll(file: string): State {
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

export function isUltracodeOn(sessionId: string | undefined, file = STATE_FILE): boolean {
  return !!sessionId && readAll(file)[sessionId] === true
}

const tails = new Map<string, Promise<unknown>>()

export function setUltracodeOn(sessionId: string, on: boolean, file = STATE_FILE): Promise<void> {
  const run = async (): Promise<void> => {
    const all = await readPersistedJson<State>(file, parseState, () => ({}))
    if (on) all[sessionId] = true
    else delete all[sessionId]
    await atomicWriteFile(file, JSON.stringify(all))
  }
  const next = (tails.get(file) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => undefined)
  tails.set(file, settled)
  void settled.then(() => {
    if (tails.get(file) === settled) tails.delete(file)
  })
  return next
}
