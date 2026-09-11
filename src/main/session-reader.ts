/**
 * 从会话 JSONL 里解析消息 —— 让界面**立即**有内容。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（实测数据）
 * ══════════════════════════════════════════════════════════════════
 * 打开一个大会话原来要走 `pi switch_session` + `pi get_messages`：
 *
 *   会话文件      消息数     pi 打开      直接解析
 *   4 MB         1090       97–300ms      ~20ms
 *   17 MB         723       **2780ms**    **59ms**   ← 快 47 倍
 *
 * 而且 pi 的 `get_messages` **不含压缩前的历史**（docs/rpc.md 明确写了，
 * 要拿完整历史得用 `get_entries`）。所以大上下文会话在界面上
 * 只剩当前窗口的那部分 —— 用户感觉就是「打开很卡，然后内容还少了」。
 *
 * 所以：**先读文件把内容铺上去**（60ms，用户感觉是瞬间），
 * 再让 pi 在后台切过去（为了后续对话能接上上下文）；
 * pi 切完推来的权威 `sync` 会覆盖一次。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不早点这么做（以及为什么现在可以）
 * ══════════════════════════════════════════════════════════════════
 * `sessions.ts` 的注释写着「我们不解析整个会话文件（格式是 version:3，会变）」——
 * 那个顾虑是对的，所以这里的设计是**纯附加、可失败**：
 *   · 任何一行解析不出来就跳过那一行（不让整个会话读不出来）
 *   · 整个文件读不出来就返回 null，调用方回退到「等 pi」
 *   · 只读 `message` 类型的 entry，格式认识不全也不影响主流程
 * 也就是说：这个模块坏了，退化到原来的行为，不会更糟。
 *
 * ══════════════════════════════════════════════════════════════════
 * 体积控制（17MB 里 75% 是超大 tool result）
 * ══════════════════════════════════════════════════════════════════
 * 实测：26 行 >100KB，合计 12.9MB / 17.1MB。最长一行 4MB ——
 * 是个 `toolResult`，内容是 **text + base64 图片**。
 * 把 4MB 的 base64 交给渲染端会直接卡死界面，所以这里做**有损降级**：
 *   · 超长文本 → 截断 + 标记（界面上明说"已截断"，不假装完整）
 *   · 超大图片 → 丢弃 + 占位（保留尺寸信息，让用户知道这里有张图）
 */
import { open } from 'node:fs/promises'
import { normalizeHistory } from './normalize'
import type { UIMessage } from '../shared/ipc'

/** 单行超过这个长度就不整体 parse（避免瞬时内存峰值） */
const MAX_LINE_BYTES = 6 * 1024 * 1024

/** tool result 的文本保留上限（超出截断并标记） —— 64KB ≈ 一个屏都看不完 */
const MAX_TEXT = 64 * 1024

/** 单张图片的 base64 上限（超出丢弃，只留占位说明） */
const MAX_IMAGE = 256 * 1024

export interface ReadResult {
  messages: UIMessage[]
  /** 文件里一共多少条 message entry（可能大于 messages.length，因为有跳过的） */
  total: number
  /** 被截断的超长内容条数 —— 界面可以据此提示「有内容被省略」 */
  truncated: number
  /** 文件字节数（诊断用） */
  bytes: number
}

/**
 * 把一行 JSON 里的超大内容换成占位符。
 *
 * 为什么要在 **parse 之前**动字符串：4MB 的 base64 直接 JSON.parse 后
 * 会常驻内存，而 V8 解析这么大的字符串还会额外分配。
 * 但完全跳过这一行又会让用户丢掉整个 tool result（里面有命令输出）。
 * 折中：只替换 `"data":"..."` 这个字段的值（用字符串替换，不 parse）。
 */
function shrinkLine(line: string): string {
  // 图片 data 字段：`"data":"<超长 base64>"`
  return line.replace(/"data":"([A-Za-z0-9+/=]{20000,})"/g, (_m, b64: string) => {
    const kb = Math.round(b64.length / 1024)
    return `"data":"","__yanImageDropped":"${kb}KB 图片未载入（体积过大）"`
  })
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
    let cut = 0
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // image block：data 太大就直接丢
      if (k === 'data' && typeof val === 'string' && val.length > MAX_IMAGE) {
        out[k] = ''
        out.__dropped = `${Math.round(val.length / 1024)}KB`
        cut += 1
        continue
      }
      const r = truncateDeep(val, depth + 1)
      cut += r.cut
      out[k] = r.value
    }
    return { value: out, cut }
  }

  return { value: v, cut: 0 }
}

/**
 * 读一个会话文件，返回可直接渲染的消息。
 *
 * 失败一律返回 null（调用方回退到「等 pi 的 get_messages」）。
 */
export async function readSessionMessages(path: string): Promise<ReadResult | null> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }

  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const r = await fh.read(buf, read, size - read, read)
      if (r.bytesRead <= 0) break
      read += r.bytesRead
    }

    const raw = buf.toString('utf8')
    const lines = raw.split('\n')

    const normalized: unknown[] = []
    let total = 0
    let truncated = 0

    for (const rawLine of lines) {
      if (!rawLine) continue
      // 快筛：只关心消息 entry（custom entry 由 refreshTodos 单独处理）
      if (!rawLine.includes('"type":"message"')) continue

      // 超大行先做无损之外的收缩（只动 base64 字段）
      const line = rawLine.length > MAX_LINE_BYTES ? shrinkLine(rawLine) : rawLine
      if (line.length > MAX_LINE_BYTES) {
        // 收缩后仍然过大（比如超长纯文本），整行跳过并计数
        truncated++
        continue
      }

      try {
        const entry = JSON.parse(line) as { message?: unknown }
        const msg = entry.message
        if (!msg || typeof msg !== 'object') continue

        const r = truncateDeep(msg)
        truncated += r.cut
        total++
        normalized.push(r.value)
      } catch {
        /* 单行坏了就跳过 —— 不让一行毁掉整个会话 */
      }
    }

    return {
      messages: normalizeHistory(normalized),
      total,
      truncated,
      bytes: size
    }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}
