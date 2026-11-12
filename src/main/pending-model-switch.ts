import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAN_DIR } from './paths'

export const PENDING_MODEL_SWITCH_DIR = 'pending-model-switch'
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const RETRY_ATTEMPTS = 8
const RETRY_BACKOFF_MS = 10

export interface PendingModelSwitchTarget {
  provider?: string
  id?: string
  thinkingLevel?: string
}

function retrySync(action: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      action()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_CODES.has(code) || attempt >= RETRY_ATTEMPTS) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_BACKOFF_MS * (attempt + 1))
    }
  }
}

function fileOf(sessionId: string, root: string): string {
  return join(root, PENDING_MODEL_SWITCH_DIR, `${sessionId.replace(/[^\w.-]/g, '_')}.json`)
}

export function writePendingModelSwitch(sessionId: string, target: PendingModelSwitchTarget | null, root = YAN_DIR): void {
  const file = fileOf(sessionId, root)
  if (!target) {
    retrySync(() => rmSync(file, { force: true }))
    return
  }
  mkdirSync(join(root, PENDING_MODEL_SWITCH_DIR), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(target), 'utf8')
  try {
    retrySync(() => renameSync(tmp, file))
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function readPendingModelSwitch(sessionId: string, root = YAN_DIR): PendingModelSwitchTarget | null {
  try {
    const raw = JSON.parse(readFileSync(fileOf(sessionId, root), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as PendingModelSwitchTarget : null
  } catch {
    return null
  }
}

export function takePendingModelSwitch(sessionId: string, root = YAN_DIR): PendingModelSwitchTarget | null {
  const target = readPendingModelSwitch(sessionId, root)
  if (target) retrySync(() => rmSync(fileOf(sessionId, root), { force: true }))
  return target
}
