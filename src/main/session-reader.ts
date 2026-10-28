import { open, realpath, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { entryMessage } from './normalize'
import { SessionItemProjector } from './session-items/projector'
import { contextFromEntry } from './compaction'
import type { ContextFrom, UIMessage } from '../shared/ipc'

const MAX_LINE_BYTES = 48 * 1024 * 1024

const MAX_TEXT = 64 * 1024

export interface ReadResult {
  messages: UIMessage[]
  total: number
  truncated: number
  bytes: number
  sessionId?: string
  sourceCwd?: string
  segments?: number
  missing?: number
  contextFrom?: ContextFrom
}

function truncateDeep(v: unknown, depth = 0): { value: unknown; cut: number } {
  if (depth > 8) return { value: v, cut: 0 }

  if (typeof v === 'string') {
    if (v.length > MAX_TEXT) {
      const head = v.slice(0, MAX_TEXT)
      return {
        value: `${head}\n\n[…已截断：原始 ${Math.round(v.length / 1024)}KB，只显示前 ${MAX_TEXT / 1024}KB]`,
        cut: 1
      }
    }
    return { value: v, cut: 0 }
  }

  if (Array.isArray(v)) {
    let cut = 0
    const out = v.map((x) => {
      const r = truncateDeep(x, depth + 1)
      cut += r.cut
      return r.value
    })
    return { value: out, cut }
  }

  if (v && typeof v === 'object') {
    if ((v as { type?: unknown }).type === 'image') return { value: v, cut: 0 }

    let cut = 0
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const r = truncateDeep(val, depth + 1)
      cut += r.cut
      out[k] = r.value
    }
    return { value: out, cut }
  }

  return { value: v, cut: 0 }
}


const LINE_HEAD_CHARS = 512

interface LinkedEntry {
  id?: string
  parentId?: string | null
  value?: unknown
  meta?: boolean
}

const META_ENTRY = /^\{"type":"(session_info|label)"/

function linkOf(entry: { id?: unknown; parentId?: unknown; type?: unknown }): LinkedEntry {
  return {
    ...(typeof entry.id === 'string' && entry.id ? { id: entry.id } : {}),
    ...(entry.parentId === null || typeof entry.parentId === 'string' ? { parentId: entry.parentId } : {}),
    ...(entry.type === 'session_info' || entry.type === 'label' ? { meta: true } : {})
  }
}

function linkOfHead(head: string): LinkedEntry {
  const id = /"id":"([^"]+)"/.exec(head)?.[1]
  const parent = /"parentId":(null|"([^"]*)")/.exec(head)
  return {
    ...(id ? { id } : {}),
    ...(parent ? { parentId: parent[1] === 'null' ? null : parent[2] } : {}),
    ...(META_ENTRY.test(head) ? { meta: true } : {})
  }
}

export function leafBranch(entries: readonly LinkedEntry[], linked = true): LinkedEntry[] {
  const leaf = entries.findLast((entry) => !entry.meta) ?? entries.at(-1)
  const all = entries.filter((entry) => entry.value !== undefined)
  if (!linked || !leaf?.id) return all
  const parents = new Map<string, string | null | undefined>()
  for (const entry of entries) if (entry.id) parents.set(entry.id, entry.parentId)
  const onPath = new Set<string>()
  for (let id: string | null | undefined = leaf.id; id && !onPath.has(id); id = parents.get(id)) onPath.add(id)
  return all.filter((entry) => entry.id !== undefined && onPath.has(entry.id))
}

type ReadOptions ={ localizeImage?: (mimeType: string, data: string) => string }
const inFlight = new Map<string, Promise<ReadResult | null>>()
const localizers = new WeakMap<NonNullable<ReadOptions['localizeImage']>, number>()
let localizerSeq = 0

const MAX_SNAPSHOTS = 6
const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024
const DEFAULT_SNAPSHOT_TTL_MS = 30_000

function snapshotTtlMs(): number {
  const raw = process.env.YAN_HISTORY_CACHE_TTL_MS
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SNAPSHOT_TTL_MS
}

interface Snapshot {
  path: string
  localizer: number
  result: ReadResult
  at: number
}

const snapshots = new Map<string, Snapshot>()
let snapshotBytes = 0

function versionKey(path: string, version: BigIntStats, localizer: number): string {
  return JSON.stringify([path, String(version.dev), String(version.ino), String(version.size),
    String(version.mtimeNs), String(version.ctimeNs), localizer])
}

function dropSnapshot(key: string): void {
  const snapshot = snapshots.get(key)
  if (!snapshot) return
  snapshots.delete(key)
  snapshotBytes -= snapshot.result.bytes
}

function hitSnapshot(key: string): ReadResult | undefined {
  const snapshot = snapshots.get(key)
  if (!snapshot) return undefined
  if (Date.now() - snapshot.at > snapshotTtlMs()) {
    dropSnapshot(key)
    return undefined
  }
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  return snapshot.result
}

export function clearSessionReadCache(): void {
  snapshots.clear()
  snapshotBytes = 0
}

function keepSnapshot(key: string, path: string, localizer: number, result: ReadResult): void {
  if (result.bytes > MAX_SNAPSHOT_BYTES) return
  for (const [cachedKey, snapshot] of snapshots) {
    if (snapshot.path === path && snapshot.localizer === localizer) dropSnapshot(cachedKey)
  }
  while (snapshots.size) {
    if (snapshots.size < MAX_SNAPSHOTS && snapshotBytes + result.bytes <= MAX_SNAPSHOT_BYTES) break
    const oldest = snapshots.keys().next()
    if (oldest.done) break
    dropSnapshot(oldest.value)
  }
  snapshots.set(key, { path, localizer, result, at: Date.now() })
  snapshotBytes += result.bytes
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

export async function readSessionMessages(path: string, opts?: ReadOptions): Promise<ReadResult | null> {
  try {
    const canonical = await realpath(path)
    const version = await stat(path, { bigint: true })
    let localizer = 0
    if (opts?.localizeImage) {
      localizer = localizers.get(opts.localizeImage) ?? ++localizerSeq
      localizers.set(opts.localizeImage, localizer)
    }
    const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const key = versionKey(identity, version, localizer)
    const cached = hitSnapshot(key)
    if (cached) return cached
    const existing = inFlight.get(key)
    if (existing) return existing
    const task = readStable(path, opts).then(read => {
      if (!read) return null
      const result = freezeSnapshot(read.result)
      keepSnapshot(versionKey(identity, read.version, localizer), identity, localizer, result)
      return result
    })
    inFlight.set(key, task)
    try { return await task }
    finally { if (inFlight.get(key) === task) inFlight.delete(key) }
  } catch { return null }
}

async function readStable(path: string, opts?: ReadOptions): Promise<{ result: ReadResult; version: BigIntStats } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fh
    try {
      fh = await open(path, 'r')
      const before = await fh.stat({ bigint: true })
      const size = Number(before.size)
      if (!before.isFile() || !Number.isSafeInteger(size)) return null
      const projector = new SessionItemProjector(opts?.localizeImage)
      let total = 0, truncated = 0
      let sessionId: string | undefined, sourceCwd: string | undefined, contextFrom: ContextFrom | undefined
      let parts: string[] = [], chars = 0, discarded = false, hasMessage = false, scanTail = '', lineHead = ''
      const entries: LinkedEntry[] = []
      let linked = true
      const piece = (text: string): void => {
        if (!text) return
        if (lineHead.length < LINE_HEAD_CHARS) lineHead += text.slice(0, LINE_HEAD_CHARS - lineHead.length)
        chars += text.length
        const scan = scanTail + text
        hasMessage ||= scan.includes('"type":"message"') || scan.includes('"type":"custom_message"') || scan.includes('"type":"branch_summary"')
        scanTail = scan.slice(-32)
        if (chars > MAX_LINE_BYTES) { discarded = true; parts = [] }
        if (!discarded) parts.push(text)
      }
      const link = (entry: LinkedEntry): void => {
        if (entry.parentId === undefined) linked = false
        entries.push(entry)
      }
      const flush = (): void => {
        const isHeader = lineHead.startsWith('{"type":"session"')
        if (discarded) {
          if (hasMessage) truncated++
          if (!isHeader) link(linkOfHead(lineHead))
        } else if (chars) {
          const rawLine = parts.join('')
          if ((!sessionId || !sourceCwd) && rawLine.includes('"type":"session"')) {
            try {
              const head = JSON.parse(rawLine) as { id?: unknown; cwd?: unknown }
              if (!sessionId && typeof head.id === 'string' && head.id) sessionId = head.id
              if (!sourceCwd && typeof head.cwd === 'string' && head.cwd.trim()) sourceCwd = head.cwd
            } catch { }
          }
          if (rawLine.startsWith('{"type":"compaction"')) {
            try { contextFrom = contextFromEntry(JSON.parse(rawLine)) ?? contextFrom } catch { }
          }
          if (hasMessage) {
            let linkedEntry: LinkedEntry | undefined
            try {
              const entry = JSON.parse(rawLine) as { message?: unknown; id?: unknown; parentId?: unknown }
              linkedEntry = linkOf(entry)
              const message = entryMessage(entry)
              if (message) {
                const result = truncateDeep(message)
                linkedEntry.value = result.value; truncated += result.cut; total++
              }
            } catch { }
            if (!isHeader) link(linkedEntry ?? linkOfHead(lineHead))
          } else if (!isHeader) link(linkOfHead(lineHead))
        }
        parts = []; chars = 0; discarded = false; hasMessage = false; scanTail = ''; lineHead = ''
      }
      const decoder = new StringDecoder('utf8')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      const consume = (text: string): void => {
        let start = 0, end: number
        while ((end = text.indexOf('\n', start)) !== -1) {
          piece(text.slice(start, end)); flush(); start = end + 1
        }
        piece(text.slice(start))
      }
      while (offset < size) {
        const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
        if (!bytesRead) break
        offset += bytesRead
        consume(decoder.write(buffer.subarray(0, bytesRead)))
      }
      consume(decoder.end())
      const after = await fh.stat({ bigint: true })
      const current = await stat(path, { bigint: true })
      if (offset !== size || !sameFile(before, after) || !sameFile(before, current) ||
          after.size < before.size || current.size < before.size ||
          (after.size === before.size && !sameVersion(before, after)) ||
          (current.size === before.size && !sameVersion(before, current))) continue
      if (after.size === before.size && current.size === before.size) flush()
      for (const entry of leafBranch(entries, linked)) projector.appendPersisted(entry.value, entry.id)
      return { version: before, result: { messages: projector.uiMessages(), total, truncated, bytes: size,
        ...(sessionId ? { sessionId } : {}), ...(sourceCwd ? { sourceCwd } : {}), ...(contextFrom ? { contextFrom } : {}) } }
    } catch { if (attempt === 0) continue; return null }
    finally { await fh?.close().catch(() => undefined) }
  }
  return null
}
