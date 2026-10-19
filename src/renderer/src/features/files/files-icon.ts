import {
  Archive,
  Code,
  Database,
  File,
  Globe,
  Image,
  Presentation,
  Scroll,
  Sheet,
  StickyNote,
  type LucideIcon
} from 'lucide-react'

export type FilesIconKind = 'note' | 'web' | 'code' | 'sheet' | 'slides' | 'image' | 'archive' | 'data' | 'skill' | 'file'

export interface FilesIconSpec {
  Icon: LucideIcon
  kind: FilesIconKind
}

const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'lua', 'r', 'sql', 'graphql', 'gql',
  'vue', 'svelte', 'astro', 'css', 'scss', 'less', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'json',
  'jsonc', 'json5', 'lock', 'gradle', 'cmake', 'make', 'mk', 'dockerfile', 'zig', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml',
  'scala', 'clj', 'pl', 'vim', 'proto'
])
const NOTE = new Set(['md', 'markdown', 'mdx'])
const WEB = new Set(['html', 'htm', 'xhtml'])
const SHEET = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods'])
const SLIDES = new Set(['ppt', 'pptx', 'odp', 'key'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif', 'tif', 'tiff', 'heic'])
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz', 'zst'])
const DATA = new Set(['jsonl', 'ndjson', 'parquet', 'db', 'sqlite', 'sqlite3', 'duckdb'])
const SKILL = new Set(['skill', 'plugin'])
const CODE_NAMES = new Set(['dockerfile', 'makefile', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function filesIconKind(name: string): FilesIconKind {
  const lower = name.toLowerCase()
  if (lower === 'skill.md') return 'skill'
  const ext = extensionOf(name)
  if (SKILL.has(ext)) return 'skill'
  if (NOTE.has(ext)) return 'note'
  if (WEB.has(ext)) return 'web'
  if (DATA.has(ext)) return 'data'
  if (SHEET.has(ext)) return 'sheet'
  if (SLIDES.has(ext)) return 'slides'
  if (IMAGE.has(ext)) return 'image'
  if (ARCHIVE.has(ext)) return 'archive'
  if (CODE.has(ext) || CODE_NAMES.has(lower)) return 'code'
  return 'file'
}

const ICONS: Record<FilesIconKind, LucideIcon> = {
  note: StickyNote,
  web: Globe,
  code: Code,
  sheet: Sheet,
  slides: Presentation,
  image: Image,
  archive: Archive,
  data: Database,
  skill: Scroll,
  file: File
}

export function filesIconSpec(name: string): FilesIconSpec {
  const kind = filesIconKind(name)
  return { Icon: ICONS[kind], kind }
}
