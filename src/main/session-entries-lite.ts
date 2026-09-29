import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

/**
 * 会话文件的轻量条目索引：只给「任务清单 / 自定义条目 / 用户轮次」这类读者用。
 *
 * 为什么不用 pi 的 `get_entries`：它把整份会话（含工具结果里的 base64 图片）
 * 一次性经 RPC 送过来。大图会话一次就是几十 MB（实测 42MB 会话 → 40MB 一条响应），
 * 而任务清单每次工具执行完都要刷新 —— 主进程反复解析几十 MB 只为数几条自定义条目。
 *
 * 这里直接读 pi 写的 JSONL，并且**只读新追加的部分**：
 *   · `custom` 条目整条保留（任务清单、扩展状态都在 data 里，本身很小）；
 *   · `message` 条目只留 `{ type, id, message: { role } }`，内容一律丢掉；
 *   · 其余类型不保留。
 * 消息行不做 JSON.parse：pi 写行时 `type` 在最前、`message.role` 紧跟在头部字段后，
 * 只看行首一小段就够判定，几 MB 的图片行不会被整行解析。
 *
 * 文件被截短或换了文件（分叉、换会话）时从头重建。读不了文件时返回 null，
 * 调用方退回 `get_entries`（刚建、还没落盘的新会话就是这种情况）。
 */
export type LiteEntry = Record<string, unknown>

interface IndexState {
  file: string
  offset: number
  /** 上次读到末尾时不完整的半行（pi 正在写） */
  tail: string
  /** 按字节流解码：读取停在多字节字符中间时，不完整的字节留到下一轮，不会变成替换字符 */
  decoder: StringDecoder
  entries: LiteEntry[]
}

const HEAD_CHARS = 400

export class SessionEntriesLite {
  private state: IndexState | null = null
  /** 读取串行排队：每次只接着上次的偏移读，不会两次并发读同一段 */
  private chain: Promise<unknown> = Promise.resolve()

  /** 当前文件的轻量条目（按文件顺序）。返回的是索引内数组的快照副本。 */
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
    let s = this.state
    if (!s || s.file !== file || size < s.offset) {
      s = { file, offset: 0, tail: '', decoder: new StringDecoder('utf8'), entries: [] }
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
      /* 读到一半失败：下次从头重建，不留半截索引 */
      this.state = null
      return null
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }
}

/** 一行 JSONL → 轻量条目；与任务清单无关的行返回 null */
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
    /* 字段顺序不是预期的样子：退回整行解析，保证轮次不数错 */
    try {
      const e = JSON.parse(line) as { id?: unknown; message?: { role?: unknown } }
      return { type: 'message', ...(typeof e.id === 'string' ? { id: e.id } : {}), message: { role: e.message?.role } }
    } catch {
      return null
    }
  }
  return null
}
