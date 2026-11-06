import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SubagentRun } from '../shared/ipc'

export type UndeliveredNotices = Record<string, SubagentRun[]>

export interface SubagentNoticeStore {
  load(): UndeliveredNotices
  save(state: UndeliveredNotices): void
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function slimNoticeRun(run: SubagentRun): SubagentRun {
  return { ...run, transcript: [] }
}

export function createSubagentNoticeStore(file: string, now: () => number = Date.now): SubagentNoticeStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; state?: unknown }
        if (parsed?.version !== 1 || !parsed.state || typeof parsed.state !== 'object') return {}
        const out: UndeliveredNotices = {}
        for (const [key, runs] of Object.entries(parsed.state as Record<string, unknown>)) {
          if (!Array.isArray(runs)) continue
          const fresh = runs.filter((run): run is SubagentRun =>
            !!run && typeof run === 'object' && typeof (run as SubagentRun).id === 'string' &&
            now() - (Number((run as SubagentRun).endedAt) || Number((run as SubagentRun).startedAt) || 0) < MAX_AGE_MS)
          if (fresh.length) out[key] = fresh.map((run) => ({ ...run, transcript: [] }))
        }
        return out
      } catch {
        return {}
      }
    },
    save(state) {
      const temp = `${file}.${process.pid}.tmp`
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(temp, JSON.stringify({ version: 1, state }), 'utf8')
        renameSync(temp, file)
      } catch (error) {
        console.warn('[subagent-notify] 未投递通知没能写盘', error)
      }
    }
  }
}
