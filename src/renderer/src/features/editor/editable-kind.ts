export const SCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs'])
export const TYPESCRIPT_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts'])
export const MARKUP_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
export const STYLE_EXTENSIONS = new Set(['css', 'scss', 'less'])
export const DOC_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const PLAIN_EDITABLE = new Set(['json', 'jsonc', 'py', 'txt', 'log', 'yml', 'yaml', 'toml', 'ini', 'sh', 'sql'])

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function editorIsEditableKind(name: string): boolean {
  const ext = fileExtension(name)
  if (!ext) return false
  return (
    SCRIPT_EXTENSIONS.has(ext) ||
    TYPESCRIPT_EXTENSIONS.has(ext) ||
    MARKUP_EXTENSIONS.has(ext) ||
    STYLE_EXTENSIONS.has(ext) ||
    DOC_EXTENSIONS.has(ext) ||
    PLAIN_EDITABLE.has(ext)
  )
}
