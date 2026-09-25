import type { UIMessage } from '../../../shared/ipc'

/**
 * 把本地那份图片预览粘回「重新从会话文件读出来」的消息列表。
 *
 * 为什么需要（用户 2026-09-25：「自动压缩后图片之类的预览看不到了」）：
 *
 *   · 用户贴的图在**本地这份消息**里是完整 base64，界面直接 `data:` 渲染；
 *   · 压缩结束（`compaction_end`）会调 `hydrate()`，它按**磁盘上的完整历史**
 *     重建整份消息列表（`main/session-reader.ts`）—— 那里为内存与传输体积
 *     把超大图片 data 置空（实测用户 128 张图，**没有一张**低于阈值），
 *     于是这份列表里图片要么是空 data、要么整块消失；
 *   · `sync` 到了渲染端又是**整份替换**（store 的 `case 'sync'`），
 *     本地那份带图的消息就被覆盖掉了。
 *
 * 匹配用消息 id（`m<序号>`，由 `normalize.ts` 按“产出顺序”编，压缩**不会**
 * 删磁盘历史，所以序号稳定），并额外核对 role 与文本 —— 分叉 / 切会话时
 * 序号可能指向别的内容，那种情况宁可不显示图，也不能把图挂到别人身上。
 *
 * 只补**没有图**的消息：新列表自带图片的（刚发完、还没走过 hydrate）
 * 一律以新列表为准，不做双向合并。
 */
export function keepLocalImages(prev: UIMessage[], next: UIMessage[]): UIMessage[] {
  if (!prev.length || !next.length) return next

  const before = new Map<string, UIMessage>()
  for (const msg of prev) if (msg.images?.length) before.set(msg.id, msg)
  if (!before.size) return next

  let changed = false
  const out = next.map((msg) => {
    /* 新列表已经有可用图片（base64 或落盘地址）→ 以它为准 */
    if (msg.images?.some((im) => im.data || im.url)) return msg
    const local = before.get(msg.id)
    if (!local?.images?.length) return msg
    if (local.role !== msg.role || (local.text ?? '') !== (msg.text ?? '')) return msg
    changed = true
    return { ...msg, images: local.images }
  })

  return changed ? out : next
}
