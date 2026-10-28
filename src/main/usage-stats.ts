import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { userInfo } from 'node:os'
import { aggregateUsageSources, localDay, type FileUsage, type UsageRange, type UsageStatsView } from '../shared/usage-stats'
import {
  canonicalUsagePath,
  defaultUsageSources,
  type UsageFileRef,
  type UsageSourceKind,
  type UsageSources
} from './usage-sources'
import { estimateCost } from '../shared/model-pricing'
import { loadModelPricing } from './model-pricing'

const CACHE_VERSION = 6

interface FileEntry {
  size: number
  offset: number
  usage: FileUsage
  sourceKind: UsageSourceKind
  forkedAt?: number
  provider?: string
  model?: string
}

export interface UsageReader {
  (range: UsageRange): Promise<UsageStatsView & { userName: string }>
}

export interface UsageScanState {
  forkedAt?: number
  provider?: string
  model?: string
}

export function countLine(line: Buffer, usage: FileUsage, state: UsageScanState = {}): void {
  let entry
  try {
    entry = JSON.parse(line.toString('utf8'))
  } catch {
    return
  }
  const ms = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (entry?.type === 'session') {
    state.forkedAt = typeof entry.parentSession === 'string' && entry.parentSession && Number.isFinite(ms) ? ms : undefined
    return
  }
  if (entry?.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
    state.provider = entry.provider
    state.model = entry.modelId
    return
  }
  if (!Number.isFinite(ms) || ms < (state.forkedAt ?? -Infinity)) return
  const day = localDay(ms)
  if (entry?.type === 'compaction' || entry?.type === 'usage') {
    const provider = typeof entry.provider === 'string' ? entry.provider : state.provider
    const model = typeof entry.model === 'string' ? entry.model : state.model
    addSpend(usage, day, entry.usage, provider, model)
    return
  }
  if (entry?.type !== 'message') return
  const message = entry.message
  const role = message?.role
  if (role !== 'user' && role !== 'assistant') return
  const u = (usage[day] ??= { m: 0, t: 0, h: {}, models: {} })
  u.m++
  const hour = String(new Date(ms).getHours())
  u.h[hour] = (u.h[hour] ?? 0) + 1
  if (role !== 'assistant') return
  if (typeof message.provider === 'string' && message.provider && typeof message.model === 'string' && message.model) {
    state.provider = message.provider
    state.model = message.model
  }
  addSpend(usage, day, message.usage, message.provider, message.model)
}

function addSpend(usage: FileUsage, day: string, recorded: Record<string, unknown> | undefined, provider: unknown, model: unknown): void {
  const total = recorded?.totalTokens
  let tokens = typeof total === 'number' ? total : NaN
  if (!Number.isFinite(tokens)) {
    tokens = 0
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const part = recorded?.[key]
      if (typeof part === 'number' && Number.isFinite(part) && part > 0) tokens += part
    }
  }
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const u = (usage[day] ??= { m: 0, t: 0, h: {}, models: {} })
  u.t += tokens
  const spent = recordedCost(recorded as { cost?: { total?: unknown } } | undefined) || estimatedCost(model, recorded)
  if (spent) u.c = (u.c ?? 0) + spent
  const key = typeof provider === 'string' && provider && typeof model === 'string' && model
    ? `${provider}/${model}`
    : ''
  if (key) u.models[key] = (u.models[key] ?? 0) + tokens
  if (key && spent) (u.modelCost ??= {})[key] = (u.modelCost[key] ?? 0) + spent
}

function recordedCost(recorded: { cost?: { total?: unknown } } | undefined): number {
  const cost = recorded?.cost?.total
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0
}

function estimatedCost(model: unknown, recorded: Record<string, unknown> | undefined): number {
  if (typeof model !== 'string' || !model) return 0
  const part = (key: string): number => {
    const value = recorded?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  const estimate = estimateCost(model, { input: part('input'), output: part('output'), cacheRead: part('cacheRead'), cacheWrite: part('cacheWrite') })
  return estimate && Number.isFinite(estimate) && estimate > 0 ? estimate : 0
}

function scan(path: string, offset: number, usage: FileUsage, state: UsageScanState): Promise<number> {
  return new Promise((resolve, reject) => {
    let pos = offset
    let rest: Buffer | null = null
    const stream = createReadStream(path, { start: offset, highWaterMark: 1 << 20 })
    stream.on('data', (chunk: Buffer | string) => {
      const buf: Buffer = rest ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer)
      let start = 0
      for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
        countLine(buf.subarray(start, nl), usage, state)
        pos += nl + 1 - start
        start = nl + 1
      }
      rest = start < buf.length ? Buffer.from(buf.subarray(start)) : null
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(pos))
  })
}

export function createUsageReader(sources: UsageSources = defaultUsageSources()): UsageReader {
  const cacheFile = sources.cacheFile
  let cache: Map<string, FileEntry> | null = null
  let building: Promise<void> | null = null

  async function loadCache(): Promise<Map<string, FileEntry>> {
    if (cache) return cache
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as { version?: number; files?: Record<string, FileEntry> }
      cache = new Map(raw.version === CACHE_VERSION && raw.files ? Object.entries(raw.files) : [])
    } catch {
      cache = new Map()
    }
    return cache
  }

  async function saveCache(map: Map<string, FileEntry>): Promise<void> {
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(map) }))
    } catch {
    }
  }

  async function collectRefs(): Promise<Array<{ ref: UsageFileRef; sourceKind: UsageSourceKind }>> {
    const [main, subagents] = await Promise.all([sources.listMain(), sources.listSubagents()])
    const tagged: Array<{ ref: UsageFileRef; sourceKind: UsageSourceKind }> = []
    const seen = new Set<string>()
    for (const [sourceKind, list] of [['main', main], ['subagent', subagents]] as const) {
      for (const ref of list) {
        const canonical = await canonicalUsagePath(ref.path)
        if (!canonical || seen.has(canonical)) continue
        seen.add(canonical)
        tagged.push({ ref: { path: canonical, size: ref.size }, sourceKind })
      }
    }
    return tagged
  }

  async function refresh(): Promise<void> {
    await loadModelPricing()
    const map = await loadCache()
    const tagged = await collectRefs()
    const alive = new Set(tagged.map((item) => item.ref.path))
    let changed = false
    for (const path of map.keys()) {
      if (!alive.has(path)) {
        map.delete(path)
        changed = true
      }
    }
    for (const { ref, sourceKind } of tagged) {
      const hit = map.get(ref.path)
      if (hit && hit.size === ref.size && hit.sourceKind === sourceKind) continue
      if (hit && hit.size === ref.size) {
        hit.sourceKind = sourceKind
        changed = true
        continue
      }
      const entry: FileEntry = hit && ref.size > hit.offset && ref.size > hit.size ? hit : { size: 0, offset: 0, usage: {}, sourceKind }
      entry.sourceKind = sourceKind
      try {
        entry.offset = await scan(ref.path, entry.offset, entry.usage, entry)
        entry.size = ref.size
        map.set(ref.path, entry)
        changed = true
      } catch {
      }
    }
    if (changed) await saveCache(map)
  }

  return async function readUsageStats(range: UsageRange): Promise<UsageStatsView & { userName: string }> {
    if (!building) building = refresh().finally(() => { building = null })
    await building
    const main: FileUsage[] = []
    const subagents: FileUsage[] = []
    for (const entry of cache?.values() ?? []) {
      if (entry.sourceKind === 'subagent') subagents.push(entry.usage)
      else main.push(entry.usage)
    }
    let userName = ''
    try {
      userName = userInfo().username
    } catch {
    }
    return { ...aggregateUsageSources({ main, subagents }, range), userName }
  }
}

let defaultReader: UsageReader | null = null

export function readUsageStats(range: UsageRange): Promise<UsageStatsView & { userName: string }> {
  defaultReader ??= createUsageReader()
  return defaultReader(range)
}
