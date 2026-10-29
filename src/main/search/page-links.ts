export function markdownLinks(text: string, base: string): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  const start = /\[([^\]\n]{0,200})\]\(\s*(<?)/g
  for (;;) {
    const match = start.exec(text)
    if (!match) break
    let cursor = start.lastIndex
    const from = cursor
    let depth = 0
    while (cursor < text.length && cursor - from <= 8192) {
      const char = text[cursor]
      if (match[2] === '<' ? char === '>' : (char === ')' && depth === 0) || /\s/.test(char)) break
      if (char === '(') depth++
      if (char === ')') depth--
      cursor++
    }
    if (cursor - from > 8192) continue
    try {
      const url = new URL(text.slice(from, cursor), base)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
      seen.add(url.href)
      links.push({ title: match[1].trim(), url: url.href })
      if (links.length >= 500) break
    } catch { }
  }
  return links
}
