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

const CACHE_VERSION = 3
const HEAD_BYTES = 240
const TAIL_BYTES = 2048

interface FileEntry {
  size: number
  offset: number
  usage: FileUsage
  sourceKind: UsageSourceKind
}

export interface UsageReader {
  (range: UsageRange): Promise<UsageStatsView & { userName: string }>
}

const ROLE = /"type":"message".*?"message":\{"role":"(user|assistant)"/
const STAMP = /"timestamp":"([^"]+)"/
const MODEL = /"provider":"([^"]{1,80})","model":"([^"]{1,160})"/g
const TOTAL = /"totalTokens":(\d+)/
const PART = /"(input|output|cacheRead|cacheWrite)":(\d+)/g
const COST = /"cost":\{[^{}]*?"total":(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/

export function countLine(line: Buffer, usage: FileUsage): void {
  const head = line.subarray(0, HEAD_BYTES).toString('utf8')
  const role = ROLE.exec(head)?.[1]
  if (!role) return
  const stamp = STAMP.exec(head)?.[1]
  const ms = stamp ? Date.parse(stamp) : NaN
  if (!Number.isFinite(ms)) return
  const day = localDay(ms)
  const u = (usage[day] ??= { m: 0, t: 0, h: {}, models: {} })
  u.m++
  const hour = String(new Date(ms).getHours())
  u.h[hour] = (u.h[hour] ?? 0) + 1
  if (role !== 'assistant') return
  const tail = line.subarray(Math.max(0, line.length - TAIL_BYTES)).toString('utf8')
  const at = tail.lastIndexOf('"usage":{')
  if (at < 0) return
  const block = tail.slice(at, tail.indexOf('}', at) + 1)
  let tokens = Number(TOTAL.exec(block)?.[1] ?? NaN)
  if (!Number.isFinite(tokens)) {
    tokens = 0
    for (const m of block.matchAll(PART)) tokens += Number(m[2])
  }
  if (tokens <= 0) return
  u.t += tokens
  const cost = Number(COST.exec(tail.slice(at))?.[1] ?? NaN)
  const spent = Number.isFinite(cost) && cost > 0 ? cost : 0
  if (spent) u.c = (u.c ?? 0) + spent
  let key = ''
  for (const m of tail.slice(0, at).matchAll(MODEL)) key = `${m[1]}/${m[2]}`
  if (key) u.models[key] = (u.models[key] ?? 0) + tokens
  if (key && spent) (u.modelCost ??= {})[key] = (u.modelCost[key] ?? 0) + spent
}

function scan(path: string, offset: number, usage: FileUsage): Promise<number> {
  return new Promise((resolve, reject) => {
    let pos = offset
    let rest: Buffer | null = null
    const stream = createReadStream(path, { start: offset, highWaterMark: 1 << 20 })
    stream.on('data', (chunk: Buffer | string) => {
      const buf: Buffer = rest ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer)
      let start = 0
      for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
        countLine(buf.subarray(start, nl), usage)
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
        entry.offset = await scan(ref.path, entry.offset, entry.usage)
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
