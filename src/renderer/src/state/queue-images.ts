import type { Attachment } from '../../../shared/ipc'
import { uiText } from '../i18n/ui-text'

export interface QueueImageRef {
  data: string
  mimeType: string
}

export interface AttachmentLimits {
  maxCount: number
  maxImageBytes: number
}

export interface QueueRecoveryInput {
  sameSession: boolean
  text: string
  images?: QueueImageRef[]
  existing: Attachment[]
  limits: AttachmentLimits
  idPrefix: string
}

export interface QueueRecovery {
  queueRestore: string | null
  attachments: Attachment[]
  restoredImages: number
  droppedImages: number
}

let imageSequence = 0

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

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
      name: uiText('state.queue.imageName'),
      mimeType,
      size: decodedBytes(base64),
      data: base64,
      preview: base64,
      kind: 'image'
    })
  }
  return out
}

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
