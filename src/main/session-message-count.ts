import { open, type FileHandle } from 'node:fs/promises'

const MESSAGE_MARK = Buffer.from('"type":"message"')
const COUNT_MAX_BYTES = 8 * 1024 * 1024
const COUNT_CHUNK = 1024 * 1024
const COUNT_ANCHOR = 64
const HEAD_ANCHOR = 256

interface MessageTally {
  lineEnd: number
  lines: number
  anchor: Buffer
  head: Buffer
}

const messageTallies = new Map<string, MessageTally>()

function countMarkedLines(buf: Buffer): { lines: number; lastNewline: number } {
  let lines = 0
  let from = 0
  for (;;) {
    const hit = buf.indexOf(MESSAGE_MARK, from)
    if (hit < 0) break
    lines++
    const newline = buf.indexOf(10, hit)
    if (newline < 0) break
    from = newline + 1
  }
  return { lines, lastNewline: buf.lastIndexOf(10) }
}

async function readRange(fh: FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.alloc(end - start)
  let done = 0
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, start + done)
    if (bytesRead <= 0) break
    done += bytesRead
  }
  return done === buf.length ? buf : buf.subarray(0, done)
}

async function tallyStillValid(fh: FileHandle, tally: MessageTally, size: number): Promise<boolean> {
  if (tally.lineEnd > size) return false
  if (!(await readRange(fh, 0, tally.head.length)).equals(tally.head)) return false
  return (await readRange(fh, tally.lineEnd - tally.anchor.length, tally.lineEnd)).equals(tally.anchor)
}

export async function countSessionMessages(path: string): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size > COUNT_MAX_BYTES) {
      messageTallies.delete(path)
      return -1
    }
    let tally = messageTallies.get(path)
    if (tally && !(await tallyStillValid(fh, tally, size))) tally = undefined
    let lineEnd = tally?.lineEnd ?? 0
    let lines = tally?.lines ?? 0
    let tail: Buffer = Buffer.alloc(0)
    for (let at = lineEnd; at < size; at += COUNT_CHUNK) {
      const chunk = await readRange(fh, at, Math.min(size, at + COUNT_CHUNK))
      const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const base = at - tail.length
      const lastNewline = buf.lastIndexOf(10)
      if (lastNewline < 0) {
        tail = buf
        continue
      }
      lines += countMarkedLines(buf.subarray(0, lastNewline + 1)).lines
      lineEnd = base + lastNewline + 1
      tail = buf.subarray(lastNewline + 1)
    }
    const anchorStart = Math.max(0, lineEnd - COUNT_ANCHOR)
    messageTallies.set(path, {
      lineEnd,
      lines,
      anchor: await readRange(fh, anchorStart, lineEnd),
      head: await readRange(fh, 0, Math.min(lineEnd, HEAD_ANCHOR))
    })
    return lines + (tail.length && tail.indexOf(MESSAGE_MARK) >= 0 ? 1 : 0)
  } catch {
    messageTallies.delete(path)
    return -1
  } finally {
    await fh.close()
  }
}

export function forgetSessionMessageCounts(present: ReadonlySet<string>): void {
  for (const path of messageTallies.keys()) if (!present.has(path)) messageTallies.delete(path)
}
