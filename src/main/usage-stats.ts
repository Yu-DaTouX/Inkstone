/**
 * 启动页用量概览的数据源：扫描 pi 会话文件，按本地日期记消息数、token 与模型。
 *
 * 会话文件是只追加的 JSONL，可能有几百 MB：
 *   · 每个文件记住已读到的字节位置，之后只读新追加的部分；文件变短或换了就从头读。
 *   · 只解码每行开头（类型、角色、时间）和结尾（模型、用量），不解析中间的正文与工具输出。
 *   · 结果缓存到数据目录，重启后不必全量重扫。
 *
 * 来源有两类：主会话（session-search 的枚举，范围不变）与子代理原生 session
 * （`<archiveDir>/sessions/<sub-id>/*.jsonl`，见 usage-sources.ts）。文件按真实路径
 * 去重后各记一份，聚合时只把子代理的 Token / 模型 / 热力图并进来。
 */
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

/**
 * 缓存格式版本。
 * v1 只有主会话、没有来源标记；v2 区分 main / subagent。版本不符时整体重建，
 * 不把新的子代理来源塞进旧缓存造成重复或漏算。
 */
const CACHE_VERSION = 2
const HEAD_BYTES = 240
const TAIL_BYTES = 2048

interface FileEntry {
  size: number
  /** 已处理到的字节位置（总在换行之后） */
  offset: number
  usage: FileUsage
  /** 这份文件属于哪一类来源（决定聚合时是否计入“次数类”指标） */
  sourceKind: UsageSourceKind
}

/** 用量读取函数；一个实例持有自己的增量缓存。 */
export interface UsageReader {
  (range: UsageRange): Promise<UsageStatsView & { userName: string }>
}

const ROLE = /"type":"message".*?"message":\{"role":"(user|assistant)"/
const STAMP = /"timestamp":"([^"]+)"/
const MODEL = /"provider":"([^"]{1,80})","model":"([^"]{1,160})"/g
const TOTAL = /"totalTokens":(\d+)/
const PART = /"(input|output|cacheRead|cacheWrite)":(\d+)/g

/** 一行 → 计入 usage；只看开头与结尾两段 */
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
  /* 模型字段在用量之前；取用量前最后一次出现的 provider/model */
  let key = ''
  for (const m of tail.slice(0, at).matchAll(MODEL)) key = `${m[1]}/${m[2]}`
  if (key) u.models[key] = (u.models[key] ?? 0) + tokens
}

/** 从 offset 读到文件末尾最后一个换行，返回新的 offset */
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

/**
 * 建一个用量读取器。默认读真实数据目录；测试传临时目录来源，避免扫到用户数据。
 */
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
      /* 缓存写不了只影响下次启动速度 */
    }
  }

  /** 把两类来源按真实路径去重后合并为同一张待扫描清单 */
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
      /* 同一物理文件换了来源：沿用已读的 usage，只换标记，不重复累计 */
      if (hit && hit.size === ref.size) {
        hit.sourceKind = sourceKind
        changed = true
        continue
      }
      /* 只追加：变长就接着读；变短（被改写）就从头重算 */
      const entry: FileEntry = hit && ref.size > hit.offset && ref.size > hit.size ? hit : { size: 0, offset: 0, usage: {}, sourceKind }
      entry.sourceKind = sourceKind
      try {
        entry.offset = await scan(ref.path, entry.offset, entry.usage)
        entry.size = ref.size
        map.set(ref.path, entry)
        changed = true
      } catch {
        /* 读不了的文件跳过，下次再试 */
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
      /* 取不到用户名就不称呼 */
    }
    return { ...aggregateUsageSources({ main, subagents }, range), userName }
  }
}

let defaultReader: UsageReader | null = null

/** 生产入口：读真实 `YAN_DIR` 下的主会话与子代理原生 JSONL。 */
export function readUsageStats(range: UsageRange): Promise<UsageStatsView & { userName: string }> {
  defaultReader ??= createUsageReader()
  return defaultReader(range)
}
