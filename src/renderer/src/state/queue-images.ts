import type { Attachment } from '../../../shared/ipc'

/**
 * 排队消息里的图片回到输入框。
 *
 * 为什么单独一层：撤回排队消息、把待发送项放回草稿、停止时回收队列，三处都要
 * 做同一件事，而图片可能以两种形状回来 —— 主进程队列快照给的是裸 base64，
 * 渲染端预览用的可能是 `data:` URL。两处的解析、体积计算和上限裁剪必须一致，
 * 否则同一张图走不同路径会得到不同大小，绕开「附件合计 20MB」的限制。
 *
 * 体积按**解码后的字节**算：base64 长度乘 3/4 再减 padding，不能直接用字符串
 * 长度（dataURL 前缀与 base64 膨胀会让一张 1MB 的图报出 1.4MB）。
 */
export interface QueueImageRef {
  data: string
  mimeType: string
}

export interface AttachmentLimits {
  maxCount: number
  maxImageBytes: number
}

export interface QueueRecoveryInput {
  /** 异步返回时用户是否还停在发起撤回的那条会话上 */
  sameSession: boolean
  /** 队列项的文字（纯图片消息为空串） */
  text: string
  images?: QueueImageRef[]
  /** 当前输入框已有的附件 */
  existing: Attachment[]
  limits: AttachmentLimits
  /** 同一批回填内保证 id 唯一 */
  idPrefix: string
}

export interface QueueRecovery {
  /** 追加到输入框的文字；没有文字时 null（不改动现有草稿） */
  queueRestore: string | null
  /** 回填后的附件列表；没有变化时就是传入的 existing */
  attachments: Attachment[]
  /** 真正放回输入框的图片数 */
  restoredImages: number
  /** 没能放回的图片数（跨会话、空数据、超上限） */
  droppedImages: number
}

let imageSequence = 0

/** base64 解码后的字节数（含 padding 修正） */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** 把队列项图片转成附件；空数据与非图片内容直接跳过。 */
export function queueImagesToAttachments(
  images: QueueImageRef[] | undefined,
  limits: AttachmentLimits,
  idPrefix: string
): Attachment[] {
  if (!images?.length || limits.maxCount <= 0) return []
  const out: Attachment[] = []
  for (const image of images) {
    if (!image?.data) continue
    const dataUrl = image.data.startsWith('data:')
    const base64 = dataUrl ? image.data.slice(image.data.indexOf(',') + 1) : image.data
    if (!base64) continue
    const mimeType = image.mimeType || 'image/png'
    out.push({
      id: `${idPrefix}-${(++imageSequence).toString(36)}`,
      name: '排队图片',
      mimeType,
      size: decodedBytes(base64),
      data: base64,
      preview: dataUrl ? image.data : `data:${mimeType};base64,${base64}`,
      kind: 'image'
    })
  }
  return out
}

/**
 * 合并到现有附件，并按与拖拽附件相同的两条上限裁剪（数量、图片合计大小）。
 *
 * 用户刚拖进来的附件优先：回填的图放不下时被丢掉的是**回填的那张**，
 * 不能反过来把用户在输入框里已有的东西挤掉。
 */
export function mergeQueueAttachments(
  existing: Attachment[],
  incoming: Attachment[],
  limits: AttachmentLimits
): { attachments: Attachment[]; skipped: number } {
  if (!incoming.length) return { attachments: existing, skipped: 0 }
  const room = Math.max(0, limits.maxCount - existing.length)
  const usedImageBytes = existing
    .filter((item) => item.kind !== 'file')
    .reduce((sum, item) => sum + item.size, 0)
  const kept: Attachment[] = []
  let acc = usedImageBytes
  for (const item of incoming) {
    if (kept.length >= room) break
    if (acc + item.size > limits.maxImageBytes) continue
    acc += item.size
    kept.push(item)
  }
  return {
    attachments: kept.length ? [...existing, ...kept] : existing,
    skipped: incoming.length - kept.length
  }
}

/**
 * 一次「把队列内容放回草稿」的完整决策：文字进草稿、图片进输入框。
 *
 * 跨会话时不回填图片：附件是全局字段（不按会话隔离），而会话草稿缓存按设计
 * 只存文字（见 state/session-runtime.ts 的 draft 注释）。把图片塞进当前输入框
 * 会让它出现在**另一条会话**的对话框里，比丢掉更糟。这类图片计入 dropped，
 * 由调用方明确告知用户。
 */
export function planQueueRecovery(input: QueueRecoveryInput): QueueRecovery {
  const text = input.text ?? ''
  const images = input.images ?? []
  if (!input.sameSession) {
    return {
      queueRestore: text || null,
      attachments: input.existing,
      restoredImages: 0,
      droppedImages: images.length
    }
  }
  const converted = queueImagesToAttachments(images, input.limits, input.idPrefix)
  const merged = mergeQueueAttachments(input.existing, converted, input.limits)
  return {
    queueRestore: text || null,
    attachments: merged.attachments,
    restoredImages: converted.length - merged.skipped,
    droppedImages: images.length - converted.length + merged.skipped
  }
}
