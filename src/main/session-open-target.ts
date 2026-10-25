import { open } from 'node:fs/promises'
import { getSessionLayout, normalizeLayoutPath } from './session-layout'
import { sessionHeaderCwd } from './session-move'
import type { SessionLayoutEntry, SessionScope } from '../shared/ipc'

export interface SessionOpenTarget {
  cwd: string
  projectId?: string
  scope: SessionScope
  fromSession: boolean
  missingCwd?: string
}

export interface SessionOpenTargetOptions {
  sessionFile?: string
  sessionId?: string
  fallbackCwd: string
  usable: (cwd: string) => Promise<{ ok: true; cwd: string } | { ok: false }>
  projectIdForCwd: (cwd: string) => string | undefined
}

const HEAD_BYTES = 16 * 1024

export async function readSessionFileCwd(sessionFile: string): Promise<string | undefined> {
  const handle = await open(sessionFile, 'r').catch(() => null)
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const cwd = sessionHeaderCwd(buffer.subarray(0, bytesRead).toString('utf8'))
    return cwd && cwd.trim() ? cwd : undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function layoutEntryOf(sessionFile?: string, sessionId?: string): Promise<SessionLayoutEntry | undefined> {
  if (!sessionFile && !sessionId) return undefined
  const layout = await getSessionLayout()
  const byId = sessionId ? layout.entries.find((entry) => entry.sessionId === sessionId) : undefined
  if (byId) return byId
  if (!sessionFile) return undefined
  const key = normalizeLayoutPath(sessionFile)
  return layout.entries.find((entry) => !!entry.sessionFile && normalizeLayoutPath(entry.sessionFile) === key)
}

export async function resolveSessionOpenTarget(options: SessionOpenTargetOptions): Promise<SessionOpenTarget> {
  const entry = await layoutEntryOf(options.sessionFile, options.sessionId)
  const headerCwd = options.sessionFile ? await readSessionFileCwd(options.sessionFile) : undefined
  let cwd: string | undefined
  for (const candidate of [headerCwd, entry?.cwd]) {
    if (!candidate || candidate === cwd) continue
    const checked = await options.usable(candidate)
    if (checked.ok) {
      cwd = checked.cwd
      break
    }
  }
  if (!cwd) {
    const recorded = entry?.cwd ?? headerCwd
    const missing = recorded ? { missingCwd: recorded } : {}
    return entry
      ? { cwd: options.fallbackCwd, ...(entry.projectId ? { projectId: entry.projectId } : {}), scope: entry.scope, fromSession: false, ...missing }
      : { ...ownershipOfFallback(options), ...missing }
  }
  if (entry) {
    return { cwd, ...(entry.projectId ? { projectId: entry.projectId } : {}), scope: entry.scope, fromSession: true }
  }
  return { cwd, ...derivedOwnership(options.projectIdForCwd(cwd)), fromSession: true }
}

function ownershipOfFallback(options: SessionOpenTargetOptions): SessionOpenTarget {
  return { cwd: options.fallbackCwd, ...derivedOwnership(options.projectIdForCwd(options.fallbackCwd)), fromSession: false }
}

function derivedOwnership(projectId: string | undefined): { projectId?: string; scope: SessionScope } {
  return projectId ? { projectId, scope: 'project' } : { scope: 'global' }
}
