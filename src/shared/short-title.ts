export interface ShortTitle {
  short: string
  truncated: boolean
}

function graphemes(text: string): string[] {
  const anyIntl = Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }
  if (typeof anyIntl.Segmenter === 'function') {
    try {
      const segmenter = new anyIntl.Segmenter(undefined, { granularity: 'grapheme' })
      return Array.from(segmenter.segment(text), (part) => part.segment)
    } catch {
    }
  }
  return Array.from(text)
}

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
