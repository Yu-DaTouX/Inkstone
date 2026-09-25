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
 *
 *   · 超长文本 → 截断 + 标记（界面上明说“已截断”，不假装完整）
 *   · 图片 → 交给调用方给的 `localizeImage` **落盘**，消息里只留文件地址
 *     （见 main/image-store.ts 的说明）。以前是“丢弃 + 占位”，结果是用户
 *     贴过的图在重启 / 切会话 / 压缩之后再也就看不到了 —— 体积问题的正解
 *     是别把 base64 放进消息，而不是把用户的内容丢掉。
 */
import { open } from 'node:fs/promises'
import { normalizeHistory } from './normalize'
import type { UIMessage } from '../shared/ipc'

/**
 * 单行超过这个长度就整行跳过（不让一行拖垬内存）。
 *
 * 从 6MB 提到 48MB:用户的图一张就有 3.4MB base64，一条消息贴两张图
 * 就会超 6MB —— 那时整条消息被跳过，连文字也不剩。
 */
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

/**
 * 读一个会话文件，返回可直接渲染的消息。
 *
 * 失败一律返回 null（调用方回退到「等 pi 的 get_messages」）。
 *
 * `localizeImage` 由调用方注入（main 那边传 main/image-store.ts 的
 * `localizeImage`）：图片 base64 转成落盘后的文件地址，消息里不携带 base64。
 */
export async function readSessionMessages(
  path: string,
  opts?: { localizeImage?: (mimeType: string, data: string) => string }
): Promise<ReadResult | null> {
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
    let sessionId: string | undefined
    let sourceCwd: string | undefined

    for (const rawLine of lines) {
      if (!rawLine) continue
      /* 文件头保留身份与工作目录；cwd 决定该段历史里的相对文件链接根目录。 */
      if ((!sessionId || !sourceCwd) && rawLine.includes('"type":"session"')) {
        try {
          const head = JSON.parse(rawLine) as { id?: unknown; cwd?: unknown }
          if (!sessionId && typeof head.id === 'string' && head.id) sessionId = head.id
          if (!sourceCwd && typeof head.cwd === 'string' && head.cwd.trim()) sourceCwd = head.cwd
        } catch {
          /* 头坏了不影响消息解析 */
        }
      }
      // 快筛：只关心消息 entry（custom entry 由 refreshTodos 单独处理）
      if (!rawLine.includes('"type":"message"')) continue

      if (rawLine.length > MAX_LINE_BYTES) {
        // 单行过大（通常是超长纯文本）→ 整行跳过并计数
        truncated++
        continue
      }

      try {
        const entry = JSON.parse(rawLine) as { message?: unknown }
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
      messages: normalizeHistory(normalized, opts?.localizeImage),
      total,
      truncated,
      bytes: size,
      ...(sessionId ? { sessionId } : {}),
      ...(sourceCwd ? { sourceCwd } : {})
    }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}
