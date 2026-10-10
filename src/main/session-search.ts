/**
 * 会话正文检索（会话切换器用）。
 *
 * 会话本体是 pi 的 JSONL 文件。这里只读它们、在内存里建一份「可见对话文字」的索引：
 *   · 只收用户与助手的文字；工具调用、工具结果、思考、图片都不进索引；
 *   · 每个会话最多保留约 400KB 文字（开头 100KB + 结尾 300KB），长会话不会撑爆内存；
 *   · 以文件的 mtime + 大小判断是否过期，未变化的文件不会重读；
 *   · 索引只在内存里，不落盘、不外传。
 *
 * 搜索是「所有词都要出现」的子串匹配（不区分大小写），按命中次数与新近程度排序，
 * 并给出命中处前后的一小段文字作片段。
 */
import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { setImmediate as yieldToIo } from 'node:timers/promises'
import { join } from 'node:path'
import { SESSIONS_DIR } from './sessions'
import { createSearchTextCollector, matchText, queryTokens } from '../shared/session-search-text'

export interface SessionSearchHit {
  path: string
  /** 命中处前后的一小段文字（已压成单行） */
  snippet: string
  /** 所有词的命中次数合计（封顶） */
  matches: number
  /** 文件修改时间，用来排序与显示 */
  updatedAt: number
}

export interface SessionSearchResult {
  hits: SessionSearchHit[]
  /** 已建好索引的会话数 / 会话文件总数；建索引期间前者小于后者 */
  indexed: number
  total: number
}

const READ_PARALLEL = 4
const MAX_INDEX_BYTES = 16 * 1024 * 1024
const MAX_LINE_CHARS = 8 * 1024 * 1024

/** Stream JSONL; oversized binary rows are skipped without retaining the rest of the row. */
export async function readSessionSearchText(path: string): Promise<string> {
  const collector = createSearchTextCollector()
  let pending = ''
  let skipping = false
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    const text = String(chunk)
    let offset = 0
    while (offset < text.length) {
      const end = text.indexOf('\n', offset)
      const part = text.slice(offset, end < 0 ? undefined : end)
      if (!skipping && pending.length + part.length <= MAX_LINE_CHARS) pending += part
      else { pending = ''; skipping = true }
      if (end < 0) break
      if (!skipping) collector.append(pending)
      pending = ''; skipping = false; offset = end + 1
    }
    await yieldToIo()
  }
  if (!skipping && pending) collector.append(pending)
  return collector.finish()
}

interface Entry {
  mtimeMs: number
  size: number
  text: string
}

const index = new Map<string, Entry>()
let building: Promise<void> | null = null
let knownFiles: Array<{ path: string; mtimeMs: number; size: number }> = []

async function listSessionFiles(): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  const dirs = [SESSIONS_DIR]
  try {
    for (const entry of await readdir(SESSIONS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(SESSIONS_DIR, entry.name))
    }
  } catch {
    return files
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        /* 文件在列目录与 stat 之间被删了：跳过 */
      }
    }
  }
  return files
}

async function refreshIndex(): Promise<void> {
  const files = await listSessionFiles()
  knownFiles = files
  const alive = new Set(files.map((f) => f.path))
  for (const path of index.keys()) if (!alive.has(path)) index.delete(path)
  // Reserve the worst-case text quota per session, so concurrent readers cannot overshoot.
  const selected = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.floor(MAX_INDEX_BYTES / (2 * (400 * 1024 + 3))))
  const retained = new Set(selected.map((f) => f.path))
  for (const path of index.keys()) if (!retained.has(path)) index.delete(path)
  const stale = selected.filter((f) => {
    const hit = index.get(f.path)
    return !hit || hit.mtimeMs !== f.mtimeMs || hit.size !== f.size
  })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < stale.length) {
      const file = stale[next++]
      try {
        const text = await readSessionSearchText(file.path)
        index.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, text })
      } catch {
        index.delete(file.path)
      }
    }
  }
  await Promise.all(Array.from({ length: READ_PARALLEL }, worker))
}

/** 保证索引是新的；同时只会有一次在建，其他调用等同一个结果 */
function ensureIndex(): Promise<void> {
  if (!building) {
    building = refreshIndex().finally(() => {
      building = null
    })
  }
  return building
}

/** 应用空闲时预热索引，第一次打开切换器就不用等 */
let warmed = false
export function warmSessionSearch(): void {
  if (warmed) return
  warmed = true
  /* 稍等片刻：启动时先把界面与 pi 让出来，索引在空闲时建 */
  setTimeout(() => void ensureIndex().catch(() => undefined), 4000).unref?.()
}

export function clearSessionSearchIndex(): void {
  index.clear()
  knownFiles = []
}

export async function searchSessionText(query: string, limit = 30): Promise<SessionSearchResult> {
  const tokens = queryTokens(query)
  if (!tokens.length) return { hits: [], indexed: index.size, total: knownFiles.length }
  await ensureIndex()
  const hits: SessionSearchHit[] = []
  for (const file of knownFiles) {
    const path = file.path
    let entry = index.get(path)
    if (!entry) {
      try { entry = { ...file, text: await readSessionSearchText(path) } }
      catch { continue }
    }
    const hit = matchText(entry.text, tokens)
    if (hit) hits.push({ path, snippet: hit.snippet, matches: Math.min(hit.matches, 40), updatedAt: entry.mtimeMs })
    await yieldToIo()
  }
  const now = Date.now()
  const score = (h: SessionSearchHit): number => h.matches + Math.max(0, 8 - (now - h.updatedAt) / (3 * 24 * 3600 * 1000))
  hits.sort((a, b) => score(b) - score(a))
  return { hits: hits.slice(0, Math.max(1, Math.min(100, limit))), indexed: index.size, total: knownFiles.length }
}
