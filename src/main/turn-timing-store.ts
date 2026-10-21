import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GenerationTiming, TurnTerminalReason, TurnTimingMeta, UIMessage } from '../shared/ipc'
import type { WaitSpan } from '../shared/turns'

export const TURN_TIMING_VERSION = 1

interface TurnTimingRecord extends TurnTimingMeta {
  v: number
  runId?: string
  waitSpans?: WaitSpan[]
  anchorId?: string
  anchorEntryId?: string
  sourceIds: string[]
  generationTimings?: (GenerationTiming | null)[]
  generationStamps?: (number | null)[]
  monotonicMs?: number
  outputTokens?: number
  final?: boolean
}

const TERMINAL_REASONS: TurnTerminalReason[] = ['completed', 'stopped', 'failed', 'interrupted']

function isTerminalReason(value: unknown): value is TurnTerminalReason {
  return typeof value === 'string' && (TERMINAL_REASONS as string[]).includes(value)
}

export function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length ? cleaned.slice(0, 120) : 'unknown'
}

export function turnTimingDir(dataDir: string): string {
  return join(dataDir, 'turn-timing')
}

export function timingKey(sessionFile: string | undefined | null): string | null {
  if (!sessionFile) return null
  const base = String(sessionFile).split(/[\\/]/).pop() ?? ''
  const trimmed = base.replace(/\.jsonl$/i, '')
  return trimmed || null
}

export function turnTimingFile(dataDir: string, sessionId: string): string {
  return join(turnTimingDir(dataDir), `${sanitizeSessionId(sessionId)}.jsonl`)
}

export async function appendTurnTiming(
  dataDir: string,
  sessionId: string,
  record: TurnTimingRecord
): Promise<boolean> {
  try {
    await mkdir(turnTimingDir(dataDir), { recursive: true })
    await appendFile(turnTimingFile(dataDir, sessionId), `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function parseRecord(line: string): TurnTimingRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<TurnTimingRecord>
  if (item.v !== TURN_TIMING_VERSION) return null
  if (typeof item.logicalTurnId !== 'string' || !item.logicalTurnId) return null
  if (typeof item.startedAt !== 'number' || typeof item.endedAt !== 'number') return null
  if (typeof item.elapsedMs !== 'number' || !Number.isFinite(item.elapsedMs)) return null
  if (!isTerminalReason(item.terminalReason)) return null
  const sourceIds = Array.isArray(item.sourceIds)
    ? item.sourceIds.filter((id): id is string => typeof id === 'string' && !!id)
    : []
  return {
    v: TURN_TIMING_VERSION,
    logicalTurnId: item.logicalTurnId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    elapsedMs: Math.max(1, Math.round(item.elapsedMs)),
    terminalReason: item.terminalReason,
    ...(typeof item.anchorId === 'string' && item.anchorId ? { anchorId: item.anchorId } : {}),
    ...(typeof item.anchorEntryId === 'string' && item.anchorEntryId ? { anchorEntryId: item.anchorEntryId } : {}),
    sourceIds,
    ...(typeof item.monotonicMs === 'number' && Number.isFinite(item.monotonicMs)
      ? { monotonicMs: item.monotonicMs }
      : {}),
    ...(typeof item.outputTokens === 'number' && Number.isFinite(item.outputTokens) && item.outputTokens > 0
      ? { outputTokens: Math.round(item.outputTokens) }
      : {}),
    ...(typeof item.final === 'boolean' ? { final: item.final } : {}),
    ...(typeof item.runId === 'string' && item.runId ? { runId: item.runId } : {}),
    ...(Array.isArray(item.waitSpans) ? { waitSpans: parseWaitSpans(item.waitSpans) } : {}),
    ...(Array.isArray(item.generationTimings)
      ? { generationTimings: parseGenerationTimings(item.generationTimings) }
      : {}),
    ...(Array.isArray(item.generationStamps) && Array.isArray(item.generationTimings) && item.generationStamps.length === item.generationTimings.length
      ? { generationStamps: item.generationStamps.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)) }
      : {})
  }
}

function parseGenerationTimings(raw: unknown[]): (GenerationTiming | null)[] {
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return null
    const g = entry as Partial<GenerationTiming>
    if (typeof g.durationMs !== 'number' || !Number.isFinite(g.durationMs) || g.durationMs < 0) return null
    const out: GenerationTiming = { durationMs: Math.max(1, Math.round(g.durationMs)) }
    if (g.startEvent === 'turn_start') out.startEvent = 'turn_start'
    if (typeof g.ttftMs === 'number' && Number.isFinite(g.ttftMs) && g.ttftMs >= 0) {
      out.ttftMs = Math.max(1, Math.round(g.ttftMs))
    }
    if (typeof g.decodeMs === 'number' && Number.isFinite(g.decodeMs) && g.decodeMs >= 0) {
      out.decodeMs = Math.max(1, Math.round(g.decodeMs))
    }
    return out
  })
}

function parseWaitSpans(raw: unknown[]): WaitSpan[] {
  const spans: WaitSpan[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const s = item as Partial<WaitSpan>
    if (typeof s.id !== 'string' || !s.id) continue
    if (typeof s.name !== 'string') continue
    if (typeof s.startedAt !== 'number' || typeof s.endedAt !== 'number') continue
    if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.endedAt)) continue
    if (s.endedAt < s.startedAt) continue
    spans.push({ id: s.id, name: s.name, startedAt: s.startedAt, endedAt: s.endedAt })
  }
  return spans
}

function mergeTurnRecords(id: string, list: TurnTimingRecord[]): TurnTimingRecord {
  const withRun = list.filter((r) => !!r.runId)
  if (!withRun.length) return list[list.length - 1]
  const byRun = new Map<string, TurnTimingRecord>()
  for (const r of withRun) byRun.set(r.runId as string, r)
  const runs = [...byRun.values()].sort((a, b) => a.startedAt - b.startedAt)
  if (runs.length === 1) return runs[0]

  const last = runs[runs.length - 1]
  const sourceIds: string[] = []
  for (const r of runs) {
    for (const sid of r.sourceIds) if (!sourceIds.includes(sid)) sourceIds.push(sid)
  }
  const waitSpans: WaitSpan[] = []
  for (const r of runs) {
    for (const s of r.waitSpans ?? []) waitSpans.push(s)
  }
  const generationTimings: (GenerationTiming | null)[] = []
  const generationStamps: (number | null)[] = []
  for (const r of runs) {
    if (!r.generationTimings?.length) continue
    generationTimings.push(...r.generationTimings)
    generationStamps.push(...(r.generationStamps ?? r.generationTimings.map(() => null)))
  }
  const anchorId = runs.map((r) => r.anchorId).find((a) => !!a)
  const anchorEntryId = runs.map((r) => r.anchorEntryId).find((a) => !!a)
  const reported = runs.filter((r) => typeof r.outputTokens === 'number')
  const outputTokens = reported.length
    ? reported.reduce((n, r) => n + (r.outputTokens ?? 0), 0)
    : undefined
  return {
    ...last,
    logicalTurnId: id,
    elapsedMs: Math.max(1, runs.reduce((n, r) => n + r.elapsedMs, 0)),
    startedAt: Math.min(...runs.map((r) => r.startedAt)),
    endedAt: Math.max(...runs.map((r) => r.endedAt)),
    sourceIds,
    ...(anchorId ? { anchorId } : {}),
    ...(anchorEntryId ? { anchorEntryId } : {}),
    ...(waitSpans.length ? { waitSpans } : {}),
    ...(generationTimings.length ? { generationTimings } : {}),
    ...(generationStamps.some((v) => v !== null) ? { generationStamps } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  }
}

export function effectiveTerminalReason(record: TurnTimingRecord): TurnTerminalReason {
  return record.final === false ? 'interrupted' : record.terminalReason
}

export async function readTurnTimings(
  dataDir: string,
  sessionId: string
): Promise<TurnTimingRecord[]> {
  let text: string
  try {
    text = await readFile(turnTimingFile(dataDir, sessionId), 'utf8')
  } catch {
    return []
  }
  const byId = new Map<string, TurnTimingRecord[]>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const record = parseRecord(line)
    if (!record) continue
    const list = byId.get(record.logicalTurnId)
    if (list) list.push(record)
    else byId.set(record.logicalTurnId, [record])
  }
  return [...byId.entries()].map(([id, list]) => mergeTurnRecords(id, list))
}

export function applyTurnTimings(messages: UIMessage[], records: TurnTimingRecord[]): UIMessage[] {
  if (!records.length || !messages.length) return messages
  const indexById = new Map<string, number>()
  messages.forEach((m, i) => indexById.set(m.id, i))
  const indexByEntryId = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.entryId) indexByEntryId.set(m.entryId, i)
  })
  const assistantByStamp = new Map<number, string | null>()
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.timestamp !== 'number') continue
    assistantByStamp.set(m.timestamp, assistantByStamp.has(m.timestamp) ? null : m.id)
  }

  const assistantsOf = (record: TurnTimingRecord): { list: UIMessage[]; anchored: boolean } => {
    const start = (record.anchorEntryId ? indexByEntryId.get(record.anchorEntryId) : undefined) ??
      (record.anchorId ? indexById.get(record.anchorId) : undefined)
    if (start !== undefined) {
      const list: UIMessage[] = []
      for (let i = start + 1; i < messages.length; i += 1) {
        if (messages[i].role === 'user') break
        if (messages[i].role === 'assistant') list.push(messages[i])
      }
      if (list.length) return { list, anchored: true }
    }
    const sourceSet = new Set(record.sourceIds)
    return {
      list: messages.filter((m) => m.role === 'assistant' && sourceSet.has(m.id)),
      anchored: false
    }
  }

  const toolKey = (id: string, name: string): string => `${id}\u0000${name}`

  const patch = new Map<string, TurnTimingMeta>()
  const genPatch = new Map<string, GenerationTiming>()
  const toolPatch = new Map<string, Map<string, { startedAt: number; endedAt: number }>>()
  for (const record of records) {
    const { list: assistants, anchored } = assistantsOf(record)
    if (!assistants.length) continue
    const target = assistants[assistants.length - 1].id
    patch.set(target, {
      logicalTurnId: record.logicalTurnId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      elapsedMs: record.elapsedMs,
      terminalReason: effectiveTerminalReason(record)
    })
    const timings = record.generationTimings ?? []
    const stamps = record.generationStamps?.length === timings.length ? record.generationStamps : undefined
    const positional = timings.length === assistants.length
    const repeated = new Set<number>()
    const seen = new Set<number>()
    for (const stamp of stamps ?? []) {
      if (stamp === null) continue
      if (seen.has(stamp)) repeated.add(stamp)
      seen.add(stamp)
    }
    for (let i = 0; i < timings.length; i += 1) {
      const timing = timings[i]
      if (!timing) continue
      const stamp = stamps?.[i] ?? null
      const byStamp = stamp === null || repeated.has(stamp) ? undefined : assistantByStamp.get(stamp)
      const id = byStamp ?? (positional ? assistants[i].id : undefined)
      if (id) genPatch.set(id, timing)
    }
    if (!anchored || !record.waitSpans?.length) continue
    const spanByTool = new Map<string, WaitSpan>()
    for (const span of record.waitSpans) {
      if (typeof span.id !== 'string' || !span.id || typeof span.name !== 'string') continue
      if (!Number.isFinite(span.startedAt) || !Number.isFinite(span.endedAt)) continue
      if (span.endedAt < span.startedAt) continue
      spanByTool.set(toolKey(span.id, span.name), span)
    }
    if (!spanByTool.size) continue
    for (const assistant of assistants) {
      const calls = assistant.toolCalls
      if (!calls?.length) continue
      let byTool: Map<string, { startedAt: number; endedAt: number }> | undefined
      for (const call of calls) {
        const span = spanByTool.get(toolKey(call.id, call.name))
        if (!span) continue
        const startedAt = call.startedAt === undefined ? span.startedAt : call.startedAt
        const endedAt = call.endedAt === undefined ? span.endedAt : call.endedAt
        if (startedAt === call.startedAt && endedAt === call.endedAt) continue
        byTool ??= new Map()
        byTool.set(toolKey(call.id, call.name), { startedAt, endedAt })
      }
      if (byTool) toolPatch.set(assistant.id, byTool)
    }
  }
  if (!patch.size && !genPatch.size && !toolPatch.size) return messages
  return messages.map((m) => {
    const meta = patch.get(m.id)
    const timing = genPatch.get(m.id)
    const tools = toolPatch.get(m.id)
    if (!meta && !timing && !tools) return m
    const toolCalls =
      tools && m.toolCalls
        ? m.toolCalls.map((call) => {
            const span = tools.get(toolKey(call.id, call.name))
            if (!span) return call
            return { ...call, startedAt: span.startedAt, endedAt: span.endedAt }
          })
        : undefined
    return {
      ...m,
      ...(meta ? { turnTiming: meta } : {}),
      ...(timing ? { generationTiming: timing } : {}),
      ...(toolCalls ? { toolCalls } : {})
    }
  })
}
