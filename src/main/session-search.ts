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
  text: string
}

const index = new Map<string, Entry>()
let building: Promise<void> | null = null
let knownFiles: Array<{ path: string; mtimeMs: number; size: number }> = []

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
  const live = new Set(knownFiles.map((file) => file.path))
  for (const path of index.keys()) if (!live.has(path)) index.delete(path)
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
    if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
      try {
        entry = { ...file, text: await readSessionSearchText(path) }
        index.set(path, entry)
        let bytes = [...index.values()].reduce((sum, value) => sum + Buffer.byteLength(value.text), 0)
        while (bytes > MAX_INDEX_BYTES && index.size > 1) {
          const oldest = index.keys().next().value as string | undefined
          if (!oldest) break
          const removed = index.get(oldest)
          index.delete(oldest)
          bytes -= removed ? Buffer.byteLength(removed.text) : 0
        }
      } catch { index.delete(path); continue }
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
