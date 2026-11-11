import type { UIMessageImage, UIToolCall } from '../../../../shared/ipc'

export function collectToolImagePreviews(calls: readonly UIToolCall[], limit = 3): { call: UIToolCall; image: UIMessageImage; index: number }[] {
  const previews: { call: UIToolCall; image: UIMessageImage; index: number }[] = []
  const seen = new Set<string>()
  for (const call of calls) {
    for (const [index, image] of (call.images ?? []).entries()) {
      const key = image.data ? `${image.mimeType}:${image.data}` : image.url
      if (!key || seen.has(key)) continue
      if (previews.length >= limit) return previews
      seen.add(key)
      previews.push({ call, image, index })
    }
  }
  return previews
}
