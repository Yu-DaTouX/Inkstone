/**
 * 链感知的会话历史读取（实施-05 S5b-4）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 用户拍板「**后台两份 JSONL、前端一条会话**」：交接之后磁盘上有两个 pi 会话文件，
 * 而用户看到的历史必须是**一条连续的对话**。拼接口径在 `shared/session-chain.ts`
 * 的 `planHistoryRead`（从旧到新），这里只负责按那个顺序**真的读文件**。
 *
 * ── 三条边界 ──
 *   ① **不改写任何 JSONL**：拼接只发生在读侧，磁盘上两段还是两段；
 *   ② **不静默丢段**：链上有文件读不到（被删 / 移走）时如实计入 `missing` ——
 *      用户少看一段历史必须能被发现，而不是悄悄断掉；
 *   ③ **没有链就是单文件**：绝大多数会话不在链上，这条路不能多出任何开销或行为差异。
 */

import { planHistoryRead } from '../shared/session-chain'
import { readSessionMessages, type ReadResult } from './session-reader'
import type { SessionChainStore } from './session-chain-service'
import type { UIMessage } from '../shared/ipc'

export type HistorySegmentHydrator = (sessionFile: string, messages: UIMessage[]) => Promise<UIMessage[]>

/**
 * 读一条会话的**完整历史**（若它在链上，按段从旧到新拼接）。
 *
 * 返回 `null` 只在「所有段都读不出来」时：调用方（agent / peek）据此回退到
 * pi 的 `get_messages`。只要有一段可读就返回那一段，不因为链的另一半丢了
 * 就整条会话显示不出来。
 */
export async function readChainMessages(
  headFile: string,
  chains: SessionChainStore | null | undefined,
  hydrate?: HistorySegmentHydrator
): Promise<ReadResult | null> {
  /*
   * A/B 反向验证通道（只用于定位「链感知是否引入时序变化」）：
   * 禁用链拼接，退回与改动前逐字一致的单文件读法。默认不开。
   */
  const readOne = async (file: string): Promise<ReadResult | null> => {
    const result = await readSessionMessages(file).catch(() => null)
    if (!result || !hydrate) return result
    const messages = await hydrate(file, result.messages).catch(() => result.messages)
    return { ...result, messages }
  }

  if (process.env.YAN_NO_CHAIN_HISTORY === '1') return readOne(headFile)
  if (!chains) return readOne(headFile)
  await chains.load()
  const plan = planHistoryRead(chains.chainOf(headFile))
  const files = plan.length ? plan : [headFile]

  const messages: ReadResult['messages'] = []
  let total = 0
  let truncated = 0
  let bytes = 0
  let sessionId: string | undefined
  let read = 0
  let missing = 0

  for (const file of files) {
    const result = await readOne(file)
    if (!result) {
      missing += 1
      continue
    }
    messages.push(...result.messages)
    total += result.total
    truncated += result.truncated
    bytes += result.bytes
    /* 会话 id 取**最后一段**的：那是当前活动段的身份（链上的旧段是历史） */
    if (result.sessionId) sessionId = result.sessionId
    read += 1
  }

  if (!read) return readOne(headFile)
  return {
    messages,
    total,
    truncated,
    bytes,
    ...(sessionId ? { sessionId } : {}),
    segments: read,
    missing
  }
}
