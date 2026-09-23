/**
 * 短标题（实施-12 U-3a，H-10a 复用）。
 *
 * 会话标题、目标标题、子代理任务都要压成一行标签。规则统一在这里，
 * 免得每处各写一份 `slice`，在 emoji / 代理对（如 🧑‍💻）上把字符切碎。
 *
 * 纯函数，不依赖 Electron。
 */

export interface ShortTitle {
  short: string
  truncated: boolean
}

/** 按字素（不是 UTF-16 码元）截断，避免切坏 emoji / 组合字符 */
function graphemes(text: string): string[] {
  const anyIntl = Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }
  if (typeof anyIntl.Segmenter === 'function') {
    try {
      const segmenter = new anyIntl.Segmenter(undefined, { granularity: 'grapheme' })
      return Array.from(segmenter.segment(text), (part) => part.segment)
    } catch {
      /* 回落 */
    }
  }
  return Array.from(text)
}

/** 压成一行并截断；空标题返回空串（调用方负责兜底文案） */
export function shortTitle(text: string | undefined | null, max = 18): ShortTitle {
  const clean = (text ?? '')
    .replace(/<[^>]{1,40}>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return { short: '', truncated: false }
  const parts = graphemes(clean)
  if (parts.length <= max) return { short: clean, truncated: false }
  return { short: `${parts.slice(0, max).join('')}…`, truncated: true }
}
