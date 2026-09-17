/**
 * 从**原始会话文件**读条目身份与水位（N21-4 / S1）。
 *
 * 这是「provenance 只能指向 raw entry identity」这条约束的入口：
 * 状态里的 `sourceWatermark` / `sourceRange` / provenance.entryId
 * 都由这里读出来的 `entryIds` 校验。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不复用 `session-reader.ts`
 * ══════════════════════════════════════════════════════════════════
 * `readSessionMessages` 把整个文件读进内存、并 JSON.parse 每一行来还原
 * 消息正文（它要的正是正文）。这里只需要两样东西：**每条 entry 的 id**
 * 与**条数**。会话文件实测 17MB、单行最长 4MB（base64 图片），
 * 为拿一个 id 去 parse 4MB 的字符串是纯浪费，而且水位检查会随状态更新
 * 频繁发生。所以：
 *   · 逐行流式读（`readline`），不整文件进内存；
 *   · 只从每行**开头**取 `type` / `id` —— pi 写 entry 的顺序是
 *     `type, id, parentId, timestamp, payload`（bundle 里核实过），
 *     所以前几百个字符足够，正文再长也不影响；
 *   · 半截行（进程被杀）不计数：行尾不是 `}` 就不认。
 *
 * 读失败一律返回 null，调用方退回「没有原始索引」的行为（只做形状校验），
 * 不让一个坏会话文件把整条链路拖死。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { watermarkFromEntryIds, type RawEntryId, type SourceWatermark } from '../shared/context-state'

/** 每行只看开头这么多字符 —— 足够覆盖 `type` 与 `id`，不碰正文 */
const HEAD_CHARS = 512

export interface SessionEntryIndex {
  /** 文件头 `type:"session"` 的 id；读不到就不给 */
  sessionId?: string
  /** 按文件顺序的原始 entry id（不含文件头） */
  entryIds: RawEntryId[]
  /** 由 entryIds 算出的水位 */
  watermark: SourceWatermark
  /** 最后一行看起来是被截断的半条 entry（进程被杀）—— 它没有被计入 */
  incompleteTail: boolean
  /** 前缀里取不到 id 的 entry 行数（格式不认识） */
  unreadableEntries: number
}

interface LineIdentity {
  type: string
  id: string | null
}

const TYPE_RE = /"type"\s*:\s*"([A-Za-z_]+)"/
const ID_RE = /"id"\s*:\s*"([^"\\]{1,200})"/

/** 从一行 JSON 的开头取 `type` / `id`；取不到返回 null */
function lineIdentity(line: string): LineIdentity | null {
  const text = line.trim()
  if (!text || text[0] !== '{' || !text.endsWith('}')) return null
  const head = text.slice(0, HEAD_CHARS)
  const type = TYPE_RE.exec(head)?.[1]
  if (!type) return null
  const id = ID_RE.exec(head)?.[1] ?? null
  return { type, id }
}

/**
 * 读一个会话文件的条目索引。
 *
 * 失败（打不开 / 读一半坏了）返回 null。
 */
export async function readSessionEntryIndex(path: string): Promise<SessionEntryIndex | null> {
  const entryIds: RawEntryId[] = []
  let sessionId: string | undefined
  let unreadableEntries = 0
  let incompleteTail = false
  let sawPartial = false
  let sawAnyLine = false

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
    /* 先等一次 open，把「文件不存在 / 没权限」与「读到一半坏了」分开 */
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
  } catch {
    return null
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      sawAnyLine = true
      const identity = lineIdentity(line)
      if (!identity) {
        /*
         * 不以 `}` 结尾的行只可能是**最后一条**被写坏（进程被杀在半路）：
         * 先记下、跳过。如果后面还有合法行出现，说明坏行在中间 ——
         * 那份文件不可信，整份索引作废（返回 null）。
         */
        if (line.trim().endsWith('}')) {
          unreadableEntries++
        } else {
          incompleteTail = true
          sawPartial = true
        }
        continue
      }
      if (sawPartial) return null
      if (identity.type === 'session') {
        if (!sessionId && identity.id) sessionId = identity.id
        continue
      }
      if (!identity.id) {
        unreadableEntries++
        continue
      }
      entryIds.push(identity.id)
    }
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }

  if (!sawAnyLine) return null

  return {
    ...(sessionId ? { sessionId } : {}),
    entryIds,
    watermark: watermarkFromEntryIds(entryIds),
    incompleteTail,
    unreadableEntries
  }
}
