import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { setImmediate as yieldToIo } from 'node:timers/promises'
import { join } from 'node:path'
import { SESSIONS_DIR } from './sessions'
import { createSearchTextCollector, matchText, queryTokens } from '../shared/session-search-text'

export interface SessionSearchHit {
  path: string
  snippet: string
  matches: number
  updatedAt: number
}

export interface SessionSearchResult {
  hits: SessionSearchHit[]
  indexed: number
  total: number
}

const MAX_INDEX_BYTES = 16 * 1024 * 1024
const MAX_LINE_CHARS = 8 * 1024 * 1024

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
  bytes: number
  text: string
}

const index = new Map<string, Entry>()
let indexBytes = 0
let building: Promise<void> | null = null
let knownFiles: Array<{ path: string; mtimeMs: number; size: number }> = []
let livePaths = new Set<string>()

export async function listSessionFiles(): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
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
      }
    }
  }
  return files
}

async function refreshIndex(): Promise<void> {
  knownFiles = await listSessionFiles()
  livePaths = new Set(knownFiles.map((file) => file.path))
  for (const path of index.keys()) if (!livePaths.has(path)) dropEntry(path)
}

function dropEntry(path: string): void {
  const entry = index.get(path)
  if (!entry) return
  indexBytes -= entry.bytes
  index.delete(path)
}

function touchEntry(path: string): void {
  const entry = index.get(path)
  if (!entry) return
  index.delete(path)
  index.set(path, entry)
}

function evictionCandidate(visited: Set<string>, keep: string): string | null {
  let missing: string | null = null
  for (const path of index.keys()) {
    if (path === keep) continue
    if (visited.has(path)) return path
    if (!livePaths.has(path)) missing ??= path
  }
  return missing
}

function cacheText(path: string, file: { mtimeMs: number; size: number }, text: string, visited: Set<string>): Entry {
  const entry: Entry = { mtimeMs: file.mtimeMs, size: file.size, bytes: Buffer.byteLength(text), text }
  if (!livePaths.has(path)) return entry
  if (entry.bytes <= MAX_INDEX_BYTES) {
    const previous = index.get(path)?.bytes ?? 0
    while (indexBytes - previous + entry.bytes > MAX_INDEX_BYTES) {
      const victim = evictionCandidate(visited, path)
      if (!victim) break
      dropEntry(victim)
    }
  }
  dropEntry(path)
  if (indexBytes + entry.bytes <= MAX_INDEX_BYTES) {
    index.set(path, entry)
    indexBytes += entry.bytes
  }
  return entry
}

function ensureIndex(): Promise<void> {
  if (!building) {
    building = refreshIndex().finally(() => {
      building = null
    })
  }
  return building
}

let warmed = false
export function warmSessionSearch(): void {
  if (warmed) return
  warmed = true
  setTimeout(() => void ensureIndex().catch(() => undefined), 4000).unref?.()
}

let scanning: Promise<unknown> = Promise.resolve()
let searchSerial = 0
const latestSearchOf = new Map<string, number>()

export function searchSessionText(query: string, limit = 30, requester?: string): Promise<SessionSearchResult> {
  const serial = ++searchSerial
  if (requester !== undefined) latestSearchOf.set(requester, serial)
  const superseded = (): boolean => requester !== undefined && latestSearchOf.get(requester) !== serial
  const run = scanning.then(() => searchNow(query, limit, superseded), () => searchNow(query, limit, superseded))
  scanning = run.catch(() => undefined)
  return run
}

async function searchNow(query: string, limit: number, superseded: () => boolean = () => false): Promise<SessionSearchResult> {
  const tokens = queryTokens(query)
  if (!tokens.length || superseded()) return { hits: [], indexed: index.size, total: knownFiles.length }
  await ensureIndex()
  const hits: SessionSearchHit[] = []
  const visited = new Set<string>()
  for (const file of knownFiles) {
    if (superseded()) return { hits: [], indexed: index.size, total: knownFiles.length }
    const path = file.path
    visited.add(path)
    let entry = index.get(path)
    if (entry && entry.mtimeMs === file.mtimeMs && entry.size === file.size) {
      touchEntry(path)
    } else {
      try {
        entry = cacheText(path, file, await readSessionSearchText(path), visited)
      } catch { dropEntry(path); continue }
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
