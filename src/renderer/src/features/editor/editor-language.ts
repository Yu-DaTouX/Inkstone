import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'

const SCRIPT = new Set(['js', 'jsx', 'mjs', 'cjs'])
const TYPESCRIPT = new Set(['ts', 'tsx', 'mts', 'cts'])
const MARKUP = new Set(['html', 'htm', 'xhtml'])
const STYLE = new Set(['css', 'scss', 'less'])
const DOC = new Set(['md', 'markdown', 'mdx'])

export function editorLanguage(name: string): Extension {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (TYPESCRIPT.has(ext)) return javascript({ typescript: true, jsx: ext === 'tsx' })
  if (SCRIPT.has(ext)) return javascript({ jsx: ext === 'jsx' })
  if (ext === 'json' || ext === 'jsonc') return json()
  if (MARKUP.has(ext)) return html()
  if (STYLE.has(ext)) return css()
  if (DOC.has(ext)) return markdown()
  if (ext === 'py') return python()
  return []
}

export function editorIsEditableKind(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return (
    SCRIPT.has(ext) ||
    TYPESCRIPT.has(ext) ||
    MARKUP.has(ext) ||
    STYLE.has(ext) ||
    DOC.has(ext) ||
    ext === 'json' ||
    ext === 'jsonc' ||
    ext === 'py' ||
    ext === 'txt' ||
    ext === 'log' ||
    ext === 'yml' ||
    ext === 'yaml' ||
    ext === 'toml' ||
    ext === 'ini' ||
    ext === 'sh' ||
    ext === 'sql'
  )
}
