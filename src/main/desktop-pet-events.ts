import type { RunSnapshot } from '../shared/runs'

export interface PetSessionEvent {
  session: { id: string; header: { id: string } }
  event: { type: string; seq: number; data: Record<string, unknown> }
}

interface TrackedRun {
  sessionId: string
  active: boolean
  phase: string
  toolCallId: string | null
  requestId: string | null
}

const TERMINAL_REASON: Record<string, string> = {
  done: 'completed',
  failed: 'error',
  stopped: 'aborted'
}

export function createPetEventTranslator(): {
  translate(payload: { upsert: RunSnapshot[]; remove: string[] }): PetSessionEvent[]
  reset(): void
} {
  const runs = new Map<string, TrackedRun>()
  let seq = 0

  const make = (sessionId: string, type: string, data: Record<string, unknown> = {}): PetSessionEvent => ({
    session: { id: sessionId, header: { id: sessionId } },
    event: { type, seq: ++seq, data }
  })

  const translateRun = (run: RunSnapshot, out: PetSessionEvent[]): void => {
    const phase = run.phase
    const prev = runs.get(run.runId)
    const tracked: TrackedRun = prev ?? { sessionId: run.sessionId, active: false, phase: '', toolCallId: null, requestId: null }
    const startTurn = (): void => {
      if (tracked.active) return
      tracked.active = true
      tracked.toolCallId = null
      tracked.requestId = null
      out.push(make(run.sessionId, 'turn/start'))
    }
    const endTool = (): void => {
      if (!tracked.toolCallId) return
      tracked.toolCallId = null
      out.push(make(run.sessionId, 'tool/result'))
    }

    if (phase.kind === 'running') {
      startTurn()
      if (phase.activity === 'tool' && phase.tool) {
        if (tracked.toolCallId !== phase.tool.callId) {
          tracked.toolCallId = phase.tool.callId
          out.push(make(run.sessionId, 'tool/call', { name: phase.tool.name, arguments: '{}' }))
        }
      } else {
        endTool()
      }
      tracked.requestId = null
    } else if (phase.kind === 'needs-you') {
      startTurn()
      if (tracked.requestId !== phase.request.id) {
        tracked.requestId = phase.request.id
        out.push(make(run.sessionId, 'approval/asked', { summary: phase.request.summary }))
      }
    } else if (phase.kind in TERMINAL_REASON) {
      if (tracked.active) {
        tracked.active = false
        tracked.toolCallId = null
        tracked.requestId = null
        out.push(make(run.sessionId, 'turn/end', { reason: { kind: TERMINAL_REASON[phase.kind] } }))
      }
    }
    tracked.phase = phase.kind
    runs.set(run.runId, tracked)
  }

  return {
    translate(payload) {
      const out: PetSessionEvent[] = []
      for (const run of payload.upsert ?? []) {
        if (run.kind !== 'session') continue
        translateRun(run, out)
      }
      for (const runId of payload.remove ?? []) {
        const tracked = runs.get(runId)
        runs.delete(runId)
        if (tracked?.active) out.push(make(tracked.sessionId, 'turn/end', { reason: { kind: 'aborted' } }))
      }
      return out
    },
    reset() {
      runs.clear()
    }
  }
}
