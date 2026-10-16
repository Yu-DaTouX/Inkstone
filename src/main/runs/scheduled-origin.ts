import type { RunModel } from '../../shared/runs'
import type { RunContext } from './registry'

export interface ScheduledOrigin {
  kind: 'scheduled'
  scopeId: string
}

export interface ScheduledOriginKey {
  sessionId?: string
  generation?: number
}

export interface ScheduledContextSeed {
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
  generation?: number
}

export function normalizeScheduledOrigin(scopeId: unknown): ScheduledOrigin | null {
  const id = typeof scopeId === 'string' ? scopeId.trim() : ''
  return id ? { kind: 'scheduled', scopeId: id } : null
}

export function scheduledRunContext(
  seed: ScheduledContextSeed,
  origin: ScheduledOrigin,
  extra: { code?: string; runId?: string } = {}
): RunContext {
  return {
    sessionId: seed.sessionId,
    kind: 'scheduled',
    scopeId: origin.scopeId,
    ...(seed.sessionPath ? { sessionPath: seed.sessionPath } : {}),
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.generation !== undefined ? { generation: seed.generation } : {}),
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.runId ? { runId: extra.runId } : {})
  }
}

export class ScheduledOriginTable {
  private readonly bySession = new Map<string, ScheduledOrigin>()
  private readonly byGeneration = new Map<number, ScheduledOrigin>()

  bind(origin: ScheduledOrigin, key: ScheduledOriginKey): void {
    if (key.sessionId) this.bySession.set(key.sessionId, origin)
    if (key.generation !== undefined) this.byGeneration.set(key.generation, origin)
  }

  resolve(key: ScheduledOriginKey): ScheduledOrigin | undefined {
    if (key.sessionId) return this.bySession.get(key.sessionId)
    if (key.generation !== undefined) return this.byGeneration.get(key.generation)
    return undefined
  }

  clear(key: ScheduledOriginKey): void {
    if (key.sessionId) this.bySession.delete(key.sessionId)
    if (key.generation !== undefined) this.byGeneration.delete(key.generation)
  }

  reset(): void {
    this.bySession.clear()
    this.byGeneration.clear()
  }

  size(): number {
    return this.bySession.size
  }
}
