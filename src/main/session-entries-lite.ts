import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export type LiteEntry = Record<string, unknown>

interface IndexState {
  file: string
  offset: number
  headerHash: string
  tail: string
  decoder: StringDecoder
  entries: LiteEntry[]
}

const HEAD_CHARS = 400

export class SessionEntriesLite {
  private state: IndexState | null = null
  private chain: Promise<unknown> = Promise.resolve()

  entries(file: string | undefined): Promise<LiteEntry[] | null> {
    if (!file) return Promise.resolve(null)
    const run = this.chain.then(() => this.update(file)).then((list) => (list ? [...list] : null))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async update(file: string): Promise<LiteEntry[] | null> {
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return null
    }
    let headerHash: string
    try {
      const fh = await open(file, 'r')
      try {
        const head = Buffer.alloc(Math.min(size, 4096))
        const { bytesRead } = await fh.read(head, 0, head.length, 0)
        headerHash = createHash('sha256').update(head.subarray(0, bytesRead)).digest('hex')
      } finally { await fh.close() }
    } catch { this.state = null; return null }
    let s = this.state
    if (!s || s.file !== file || size < s.offset || s.headerHash !== headerHash) {
      s = { file, offset: 0, headerHash, tail: '', decoder: new StringDecoder('utf8'), entries: [] }
      this.state = s
    }
    if (size === s.offset) return s.entries

    let fh
    try {
      fh = await open(file, 'r')
      const length = size - s.offset
      const buf = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const r = await fh.read(buf, read, length - read, s.offset + read)
        if (r.bytesRead <= 0) break
        read += r.bytesRead
      }
      const text = s.tail + s.decoder.write(buf.subarray(0, read))
      s.offset += read
      const lastNl = text.lastIndexOf('\n')
      s.tail = lastNl >= 0 ? text.slice(lastNl + 1) : text
      const body = lastNl >= 0 ? text.slice(0, lastNl) : ''
      let start = 0
      while (start < body.length) {
        let nl = body.indexOf('\n', start)
        if (nl < 0) nl = body.length
        const line = body.slice(start, nl)
        start = nl + 1
        const entry = liteEntryOf(line)
        if (entry) s.entries.push(entry)
      }
      return s.entries
    } catch {
      this.state = null
      return null
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }
}

export function liteEntryOf(rawLine: string): LiteEntry | null {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (!line) return null
  const head = line.slice(0, HEAD_CHARS)
  const type = /^\{"type":"([A-Za-z_]+)"/.exec(head)?.[1]
  if (type === 'custom') {
    try {
      return JSON.parse(line) as LiteEntry
    } catch {
      return null
    }
  }
  if (type === 'message') {
    const role = /"message":\{"role":"([A-Za-z]+)"/.exec(head)?.[1]
    const id = /^\{"type":"message","id":"([^"]+)"/.exec(head)?.[1]
    if (role) return { type: 'message', ...(id ? { id } : {}), message: { role } }
    try {
      const e = JSON.parse(line) as { id?: unknown; message?: { role?: unknown } }
      return { type: 'message', ...(typeof e.id === 'string' ? { id: e.id } : {}), message: { role: e.message?.role } }
    } catch {
      return null
    }
  }
  return null
}
