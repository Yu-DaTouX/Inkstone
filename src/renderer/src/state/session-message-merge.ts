/**
 * 会话消息历史的合并（纯函数，store 与 session-runtime 共用）。
 *
 * 同一个逻辑以前散在两处：`peekSession` 的文件历史要跟内存实时帧合并，
 * `sync` 权威快照也要跟当前实时消息合并，两边各写一份「谁更完整」的判据。
 * 抽出来之后，渲染端只剩一种「同 id 取更完整版本」的规则，避免两侧口径漂移。
 *
 * 关键约束（主审 2026-10-15 F01）：
 *   · 不能用「保住所有旧消息」掩盖真正的清空 / 分叉 / 导入 —— 同步只被允许
 *     保住**同一会话同一代次下正在流式的尾部**与它之后的消息，别的独有历史
 *     一律以快照为准；
 *   · 同一条消息（同 id、甚至同 timestamp）在快照与内存里都有时，按**内容量**
 *     判断哪份更新，不能只比时间戳 —— 流式增量让文本变长而 timestamp 不变；
 *   · 文件侧的 `entryId`（fork 锚点）在内存版本胜出时仍要补上，不能丢。
 */
import type { UIMessage } from '../../../shared/ipc'
import { keepLocalImages } from './keep-images'
import { latestTimestamp } from './split-snapshots'

/**
 * 一条消息的「内容量」，用来在快照历史与内存实时帧之间取更完整的那份。
 *
 * 流式增量让 text / thinking / 工具输出持续变长，但消息的 `timestamp` 可能一直不变；
 * 只比时间戳会把「文件里刚开头的半截」当成新版本，反而丢掉内存里的流式尾部。
 */
export function messageContentWeight(message: UIMessage): number {
  let weight = message.text?.length ?? 0
  if (message.thinking) weight += message.thinking.length
  for (const call of message.toolCalls ?? []) {
    weight += call.output?.length ?? 0
    if (call.argsRaw) weight += call.argsRaw.length
    if (call.images?.length) weight += call.images.length
  }
  if (message.images?.length) weight += message.images.length
  return weight
}

/** 同一条消息在快照与内存里都有时取更完整的一份；内容相同保留内存版本（可能带状态 / 计时）。 */
export function newerMessageVersion(snapshot: UIMessage, live: UIMessage): UIMessage {
  const chosen = messageContentWeight(snapshot) > messageContentWeight(live) ? snapshot : live
  /* `entryId`（fork 锚点）只有文件解析才有；内存版本缺它时从快照侧补上 */
  return chosen.entryId || !snapshot.entryId ? chosen : { ...chosen, entryId: snapshot.entryId }
}

/**
 * `peekSession` 读到的文件历史与同时存在的运行缓存 / 实时帧合并。
 *
 * 直接把文件历史整份铺上去会删掉「文件还没写、内存已经收到」的流式消息，
 * 之后按 id 的补丁就无处落点。所以：
 *   · 文件里有比内存更新的消息（别的客户端写了会话）→ 内存那份落后，直接用文件；
 *   · 否则以文件历史为骨架逐条按 id 合并，内容更完整的一份胜出；
 *   · 内存里比文件多出来的（正在流式 / 刚结束但尚未落盘）按原顺序补在末尾。
 */
export function mergePeekedHistory(fromFile: UIMessage[], live: UIMessage[]): UIMessage[] {
  if (!live.length) return fromFile
  if (!fromFile.length) return live
  /* 文件明显更新：内存整份落后，不能拿旧缓存覆盖较新的历史 */
  if (latestTimestamp(fromFile) > latestTimestamp(live)) return fromFile
  const remaining = new Map(live.map((message) => [message.id, message]))
  const merged: UIMessage[] = []
  for (const fileMessage of fromFile) {
    const liveMessage = remaining.get(fileMessage.id)
    if (!liveMessage) {
      merged.push(fileMessage)
      continue
    }
    merged.push(newerMessageVersion(fileMessage, liveMessage))
    remaining.delete(fileMessage.id)
  }
  for (const liveMessage of live) {
    if (!remaining.has(liveMessage.id)) continue
    remaining.delete(liveMessage.id)
    merged.push(liveMessage)
  }
  return merged
}

/** 以快照为骨架，逐条按 id 取「更完整的一份」；不改快照里没有的条目。 */
function mergeById(snapshot: UIMessage[], live: UIMessage[]): UIMessage[] {
  if (!snapshot.length || !live.length) return snapshot
  const byId = new Map(live.map((message) => [message.id, message]))
  let changed = false
  const merged = snapshot.map((message) => {
    const liveMessage = byId.get(message.id)
    if (!liveMessage) return message
    const version = newerMessageVersion(message, liveMessage)
    if (version !== message) changed = true
    return version
  })
  return changed ? merged : snapshot
}

/**
 * `sync` 权威快照与当前消息的合并。
 *
 * 快照是 pi 当前上下文的重读结果，正常情况下应当整份接受（清空 / 分叉 / 导入
 * 都靠它落地）。唯一要保住的是**同一会话同一代次正在流式的尾部**：pi 在
 * `message_end` 之前不会把这条助手消息放进 `get_messages`，而渲染端已经通过
 * `msg-add` / `msg-update` 累积了正文 —— 整份替换会让后续 `msg-update` 没有落点
 * （主审 F01：切回正在运行的会话后正文变 0）。
 *
 * `protectedTailId` 由调用方按「当前视图正在流式 + 身份一致」判定后传入。只补
 * 这一个 id 及其之后的内存消息，不把快照里没有的旧历史整份保回来。快照里已经有
 * 的条目仍按内容量合并（保护工具输出等更晚的增量）。
 */
export function mergeSyncHistory(
  snapshot: UIMessage[],
  live: UIMessage[],
  protectedTailId?: string
): UIMessage[] {
  /*
   * 空快照就是「这条会话确实没有历史」：清空 / 切换后残留的实时帧不能把旧消息
   * 又"补"回来（清会话依旧能清）。即使此刻还挂着流式状态，也不伪造历史。
   */
  if (!snapshot.length) return []
  if (!live.length) return snapshot
  /* 图片预览先粘回来（与旧行为一致），再决定要不要保护流式尾部。 */
  const withImages = keepLocalImages(live, snapshot)
  if (!protectedTailId) return withImages
  const merged = mergeById(withImages, live)
  const tailIndex = live.findIndex((message) => message.id === protectedTailId)
  if (tailIndex < 0) return merged
  const snapshotIds = new Set(withImages.map((message) => message.id))
  const mergedIds = new Set(merged.map((message) => message.id))
  let out = merged
  for (const message of live.slice(tailIndex)) {
    if (snapshotIds.has(message.id) || mergedIds.has(message.id)) continue
    if (out === merged) out = merged.slice()
    mergedIds.add(message.id)
    out.push(message)
  }
  return out
}
