import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAN_DIR } from './paths'

export const PENDING_MODEL_SWITCH_DIR = 'pending-model-switch'

export interface PendingModelSwitchTarget {
  provider?: string
  id?: string
  thinkingLevel?: string
}

function fileOf(sessionId: string, root: string): string {
  return join(root, PENDING_MODEL_SWITCH_DIR, `${sessionId.replace(/[^\w.-]/g, '_')}.json`)
}

export function writePendingModelSwitch(sessionId: string, target: PendingModelSwitchTarget | null, root = YAN_DIR): void {
  const file = fileOf(sessionId, root)
  if (!target) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(join(root, PENDING_MODEL_SWITCH_DIR), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(target), 'utf8')
  renameSync(tmp, file)
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
  if (target) rmSync(fileOf(sessionId, root), { force: true })
  return target
}
