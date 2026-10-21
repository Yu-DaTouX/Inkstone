import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'
import { DOC_EXTENSIONS, MARKUP_EXTENSIONS, SCRIPT_EXTENSIONS, STYLE_EXTENSIONS, TYPESCRIPT_EXTENSIONS, fileExtension } from './editable-kind'

export { editorIsEditableKind } from './editable-kind'

export function editorLanguage(name: string): Extension {
  const ext = fileExtension(name)
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return javascript({ typescript: true, jsx: ext === 'tsx' })
  if (SCRIPT_EXTENSIONS.has(ext)) return javascript({ jsx: ext === 'jsx' })
  if (ext === 'json' || ext === 'jsonc') return json()
  if (MARKUP_EXTENSIONS.has(ext)) return html()
  if (STYLE_EXTENSIONS.has(ext)) return css()
  if (DOC_EXTENSIONS.has(ext)) return markdown()
  if (ext === 'py') return python()
  return []
}
