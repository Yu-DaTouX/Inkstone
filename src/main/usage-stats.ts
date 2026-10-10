/**
 * 启动页用量概览的数据源：扫描 pi 会话文件，按本地日期记消息数、token 与模型。
 *
 * 会话文件是只追加的 JSONL，可能有几百 MB：
 *   · 每个文件记住已读到的字节位置，之后只读新追加的部分；文件变短或换了就从头读。
 *   · 只解码每行开头（类型、角色、时间）和结尾（模型、用量），不解析中间的正文与工具输出。
 *   · 结果缓存到数据目录，重启后不必全量重扫。
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { userInfo } from 'node:os'
import { YAN_DIR } from './paths'
import { listSessionFiles } from './session-search'
import { aggregateUsage, localDay, type FileUsage, type UsageRange, type UsageStatsView } from '../shared/usage-stats'

const CACHE_FILE = join(YAN_DIR, 'usage-stats.json')
const CACHE_VERSION = 1
const HEAD_BYTES = 240
const TAIL_BYTES = 2048

interface FileEntry {
  size: number
  /** 已处理到的字节位置（总在换行之后） */
  offset: number
  usage: FileUsage
}

let cache: Map<string, FileEntry> | null = null
let building: Promise<void> | null = null

async function loadCache(): Promise<Map<string, FileEntry>> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as { version?: number; files?: Record<string, FileEntry> }
    cache = new Map(raw.version === CACHE_VERSION && raw.files ? Object.entries(raw.files) : [])
  } catch {
    cache = new Map()
  }
  return cache
}

async function saveCache(map: Map<string, FileEntry>): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(map) }))
  } catch {
    /* 缓存写不了只影响下次启动速度 */
  }
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

async function refresh(): Promise<void> {
  const map = await loadCache()
  const files = await listSessionFiles()
  const alive = new Set(files.map((f) => f.path))
  let changed = false
  for (const path of map.keys()) {
    if (!alive.has(path)) {
      map.delete(path)
      changed = true
    }
  }
  for (const file of files) {
    const hit = map.get(file.path)
    if (hit && hit.size === file.size) continue
    /* 只追加：变长就接着读；变短（被改写）就从头重算 */
    const entry: FileEntry = hit && file.size > hit.offset && file.size > hit.size ? hit : { size: 0, offset: 0, usage: {} }
    try {
      entry.offset = await scan(file.path, entry.offset, entry.usage)
      entry.size = file.size
      map.set(file.path, entry)
      changed = true
    } catch {
      /* 读不了的文件跳过，下次再试 */
    }
  }
  if (changed) await saveCache(map)
}

export async function readUsageStats(range: UsageRange): Promise<UsageStatsView & { userName: string }> {
  if (!building) building = refresh().finally(() => { building = null })
  await building
  const files = [...(cache?.values() ?? [])].map((e) => e.usage)
  let userName = ''
  try {
    userName = userInfo().username
  } catch {
    /* 取不到用户名就不称呼 */
  }
  return { ...aggregateUsage(files, range === '30d' || range === '7d' ? range : 'all'), userName }
}
