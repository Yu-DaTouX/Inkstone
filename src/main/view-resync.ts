import type { RuntimeEnvelope } from '../shared/ipc'
import { describeViewResyncMissing, normalizeViewResyncRequest, type ViewResyncRequest } from '../shared/view-resync'

export interface ViewResyncRegistry {
  readonly activeRunnerId: string | null
  runtimeOf(id: string): RuntimeEnvelope | null | undefined
  hasAgent(id: string): boolean
}

export interface ViewResyncDeps {
  registry(): ViewResyncRegistry | null | undefined
  pushSnapshot(runnerId: string): Promise<void>
  log(text: string): void
}

export type ViewResyncTarget =
  | { ok: true; runnerId: string; runtime: RuntimeEnvelope }
  | { ok: false; why: string }

export function resolveViewResyncTarget(registry: ViewResyncRegistry | null | undefined, request: ViewResyncRequest): ViewResyncTarget {
  if (!registry) return { ok: false, why: 'no-runners' }
  const runnerId = request.runId ?? registry.activeRunnerId
  if (!runnerId) return { ok: false, why: 'no-runner' }
  const runtime = registry.runtimeOf(runnerId)
  if (!runtime || !registry.hasAgent(runnerId)) return { ok: false, why: 'runner-gone' }
  if (request.generation !== undefined && runtime.generation !== request.generation) return { ok: false, why: 'generation-changed' }
  if (request.sessionId && runtime.sessionId && runtime.sessionId !== request.sessionId) return { ok: false, why: 'session-changed' }
  return { ok: true, runnerId, runtime }
}

export function viewResyncLogLine(request: ViewResyncRequest, target: ViewResyncTarget): string {
  const attempt = request.attempt ? ` attempt=${request.attempt}` : ''
  const head = request.giveUp ? `stop-auto-resync reason=${request.reason}` : request.reason
  const owner = target.ok
    ? `runner=${target.runnerId} session=${target.runtime.sessionId ?? ''}`
    : `runner=${request.runId ?? ''} session=${request.sessionId ?? ''} skipped=${target.why}`
  return `${head}${attempt} ${owner} ${describeViewResyncMissing(request.missing)}`
}

export function createViewResync(deps: ViewResyncDeps): (input: unknown) => Promise<{ ok: boolean }> {
  return async (input) => {
    const request = normalizeViewResyncRequest(input)
    const target = resolveViewResyncTarget(deps.registry(), request)
    deps.log(viewResyncLogLine(request, target))
    if (request.giveUp || !target.ok) return { ok: false }
    await deps.pushSnapshot(target.runnerId)
    return { ok: true }
  }
}
