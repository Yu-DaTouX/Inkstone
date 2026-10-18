const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/

export function stripTitleMarkdown(line: string): string {
  if (FENCE_LINE.test(line)) return ''
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/`+/g, '')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2')
    .trim()
}

export function plainTitleText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(stripTitleMarkdown)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
