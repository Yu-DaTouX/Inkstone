export interface TitleSampleMessage {
  text: string
  images?: readonly { data: string; mimeType: string }[]
}

export function titleSampleText(message: TitleSampleMessage): string {
  const text = message.text.trim()
  if (text) return text
  const n = message.images?.length ?? 0
  return n > 0 ? `[图片 ×${n}]` : ''
}

export function titleSamples(messages: readonly TitleSampleMessage[]): string[] {
  const usable = messages.map(titleSampleText).filter(Boolean)
  if (usable.length === 0) return []
  if (usable.length === 1) return [usable[0]]
  return [usable[0], usable[usable.length - 1]]
}

export function titleSampleImages(
  messages: readonly TitleSampleMessage[]
): { data: string; mimeType: string }[] {
  for (const m of messages) {
    if (m.images?.length) return m.images.slice(0, 1).map((i) => ({ data: i.data, mimeType: i.mimeType }))
    if (titleSampleText(m)) break
  }
  return []
}
