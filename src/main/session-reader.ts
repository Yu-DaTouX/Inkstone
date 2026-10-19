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


type ReadOptions = { localizeImage?: (mimeType: string, data: string) => string }
const inFlight = new Map<string, Promise<ReadResult | null>>()
const localizers = new WeakMap<NonNullable<ReadOptions['localizeImage']>, number>()
let localizerSeq = 0

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
    const key = JSON.stringify([process.platform === 'win32' ? canonical.toLowerCase() : canonical,
      String(version.dev), String(version.ino), String(version.size), String(version.mtimeNs), String(version.ctimeNs), localizer])
    const existing = inFlight.get(key)
    if (existing) return existing
    const task = readStable(path, opts).then(result => result ? freezeSnapshot(result) : null)
    inFlight.set(key, task)
    try { return await task }
    finally { if (inFlight.get(key) === task) inFlight.delete(key) }
  } catch { return null }
}

async function readStable(path: string, opts?: ReadOptions): Promise<ReadResult | null> {
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
      let parts: string[] = [], chars = 0, discarded = false, hasMessage = false, scanTail = ''
      const piece = (text: string): void => {
        if (!text) return
        chars += text.length
        const scan = scanTail + text
        hasMessage ||= scan.includes('"type":"message"') || scan.includes('"type":"custom_message"') || scan.includes('"type":"branch_summary"')
        scanTail = scan.slice(-32)
        if (chars > MAX_LINE_BYTES) { discarded = true; parts = [] }
        if (!discarded) parts.push(text)
      }
      const flush = (): void => {
        if (discarded) { if (hasMessage) truncated++ }
        else if (chars) {
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
            let value: unknown, entryId: string | undefined, parsed = false
            try {
              const entry = JSON.parse(rawLine) as { message?: unknown; id?: unknown }
              const message = entryMessage(entry)
              if (message) {
                const result = truncateDeep(message)
                value = result.value; truncated += result.cut; total++
                entryId = typeof entry.id === 'string' && entry.id ? entry.id : undefined
                parsed = true
              }
            } catch { }
            if (parsed) projector.appendPersisted(value, entryId)
          }
        }
        parts = []; chars = 0; discarded = false; hasMessage = false; scanTail = ''
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
      return { messages: projector.uiMessages(), total, truncated, bytes: size,
        ...(sessionId ? { sessionId } : {}), ...(sourceCwd ? { sourceCwd } : {}), ...(contextFrom ? { contextFrom } : {}) }
    } catch { if (attempt === 0) continue; return null }
    finally { await fh?.close().catch(() => undefined) }
  }
  return null
}
