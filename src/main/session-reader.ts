/** Bounded JSONL history parsing with versioned in-flight sharing. */
import { open, realpath, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { createHistoryBuilder } from './normalize'
import type { UIMessage } from '../shared/ipc'

const MAX_LINE_BYTES = 48 * 1024 * 1024

/** tool result 的文本保留上限（超出截断并标记） —— 64KB ≈ 一个屏都看不完 */
const MAX_TEXT = 64 * 1024

export interface ReadResult {
  messages: UIMessage[]
  /** 文件里一共多少条 message entry（可能大于 messages.length，因为有跳过的） */
  total: number
  /** 被截断的超长内容条数 —— 界面可以据此提示「有内容被省略」 */
  truncated: number
  /** 文件字节数（诊断用） */
  bytes: number
  /** 会话 id（文件头 `type:"session"` 那条；旧文件读不到就不给） */
  sessionId?: string
  /** 会话文件头记录的工作目录；历史消息的相对文件链接按此解析。 */
  sourceCwd?: string
  /**
   * 这段历史由几个会话文件拼成（实施-05 S5b-4）。
   *
   * `>1` 说明这条会话是**交接过的链**（后台两份 JSONL、前端一条时间线），
   * 界面靠它知道「现在看到的不是单个文件」。
   */
  segments?: number
  /** 链上读不到的段数（文件被删 / 移走）。**不静默丢段**，如实计数 */
  missing?: number
}

/** 递归截断超长字符串字段（parse 之后） */
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
    /*
     * 图片块**整体放过**，不递归、不截断。
     *
     * 它的 `data` 是 base64 **数据**，不是给人读的文本 —— 按 `MAX_TEXT`
     * 截断会直接毁掉图片本身（实测本机：546 张图里 **474 张**超过 64KB，
     * 合计 143MB）。`normalize.ts` 的 `imagesOf` 读的就是这个 `data`，
     * 它把截断后的半截 base64 交给 `localizeImage` 落盘 → 写出一个坏 PNG
     * → 前端 `<img>` 加载失败，用户看到的就是「压缩后图片预览没了」。
     * 压缩 / 切会话 / 重启都走 hydrate，而它必经这里，所以只在
     * 压缩后才暴露。
     *
     * 体积控制**不靠这里**：`imagesOf` 会把 base64 换成文件地址，消息里
     * 最终不留 base64（那才是该管的地方）。
     *
     * 判据与 `normalize.ts` 的 `imagesOf` 保持一致，两处必须同口径。
     */
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

/** Shared snapshots are read-only; mutation/hydration requires an isolated copy. */
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

/** Read a bounded prefix; replacement/truncation gets one fresh attempt. */
async function readStable(path: string, opts?: ReadOptions): Promise<ReadResult | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fh
    try {
      fh = await open(path, 'r')
      const before = await fh.stat({ bigint: true })
      const size = Number(before.size)
      if (!before.isFile() || !Number.isSafeInteger(size)) return null
      const builder = createHistoryBuilder(opts?.localizeImage)
      let total = 0, truncated = 0
      let sessionId: string | undefined, sourceCwd: string | undefined
      let parts: string[] = [], chars = 0, discarded = false, hasMessage = false, scanTail = ''
      const piece = (text: string): void => {
        if (!text) return
        chars += text.length
        const scan = scanTail + text
        hasMessage ||= scan.includes('"type":"message"')
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
            } catch { /* A malformed head does not hide valid messages. */ }
          }
          if (hasMessage) {
            let value: unknown, entryId: string | undefined, parsed = false
            try {
              const entry = JSON.parse(rawLine) as { message?: unknown; id?: unknown }
              if (entry.message && typeof entry.message === 'object') {
                const result = truncateDeep(entry.message)
                value = result.value; truncated += result.cut; total++
                entryId = typeof entry.id === 'string' && entry.id ? entry.id : undefined
                parsed = true
              }
            } catch { /* Ignore malformed JSONL records. */ }
            if (parsed) builder.append(value, entryId)
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
      // A growing file contributes only newline-terminated records in the initial prefix.
      // A stable closed file retains the historical valid-no-final-newline behavior.
      if (after.size === before.size && current.size === before.size) flush()
      return { messages: builder.finish(), total, truncated, bytes: size,
        ...(sessionId ? { sessionId } : {}), ...(sourceCwd ? { sourceCwd } : {}) }
    } catch { if (attempt === 0) continue; return null }
    finally { await fh?.close().catch(() => undefined) }
  }
  return null
}
