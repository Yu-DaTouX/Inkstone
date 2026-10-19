import { common, createLowlight } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'
import rehypeHighlight from 'rehype-highlight'
import { visit } from 'unist-util-visit'
import type { Element, ElementContent, Root, Text } from 'hast'

export const HIGHLIGHT_MAX_CHARS = 20_000
export const HIGHLIGHT_MAX_LINES = 1_000
export const HIGHLIGHT_MAX_LINE_CHARS = 2_000

const LANGUAGE_ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  powershell: ['ps', 'ps1', 'pwsh'],
  typescript: ['ts', 'mts', 'cts', 'tsx'],
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  xml: ['html', 'htm', 'svg', 'vue'],
  markdown: ['md', 'mdx'],
  yaml: ['yml'],
  ini: ['toml', 'conf'],
  python: ['py'],
  rust: ['rs'],
  csharp: ['cs', 'c#'],
  cpp: ['c++', 'hpp', 'cc', 'hh'],
  go: ['golang'],
  kotlin: ['kt', 'kts'],
  ruby: ['rb'],
  plaintext: ['text', 'txt', 'plain', 'log']
}

const HIGHLIGHT_LANGUAGES = { ...common, powershell }
const engine = createLowlight(HIGHLIGHT_LANGUAGES)
engine.registerAlias(LANGUAGE_ALIASES)

export function exceedsHighlightLimits(code: string): boolean {
  if (code.length > HIGHLIGHT_MAX_CHARS) return true
  let lines = 1
  let lineStart = 0
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) !== 10) continue
    if (i - lineStart > HIGHLIGHT_MAX_LINE_CHARS) return true
    lines += 1
    if (lines > HIGHLIGHT_MAX_LINES) return true
    lineStart = i + 1
  }
  return code.length - lineStart > HIGHLIGHT_MAX_LINE_CHARS
}

export function highlightLanguage(lang: string | null | undefined): string | null {
  const name = (lang ?? '').trim().toLowerCase()
  if (!name) return null
  return engine.registered(name) ? name : null
}

export function highlightTree(code: string, lang: string | null | undefined): Root | null {
  const name = highlightLanguage(lang)
  if (!name || exceedsHighlightLimits(code)) return null
  try {
    return engine.highlight(name, code, { prefix: 'hljs-' })
  } catch {
    return null
  }
}

function textOf(node: Element | ElementContent): string {
  if (node.type === 'text') return (node as Text).value
  if (node.type !== 'element') return ''
  return node.children.map(textOf).join('')
}

export function rehypeMarkOversizedCode() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element, _index, parent) => {
      if (node.tagName !== 'code' || !parent || parent.type !== 'element' || parent.tagName !== 'pre') return
      if (!exceedsHighlightLimits(textOf(node))) return
      const list = Array.isArray(node.properties.className) ? [...node.properties.className] : []
      if (!list.includes('no-highlight')) list.push('no-highlight')
      node.properties.className = list
      node.properties.dataHighlight = 'plain'
    })
  }
}

export const highlightOptions = { detect: false, languages: HIGHLIGHT_LANGUAGES, aliases: LANGUAGE_ALIASES }

export { rehypeHighlight }
