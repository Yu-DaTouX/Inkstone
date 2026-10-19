import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon
} from 'lucide-react'

export type FilesIconTone = 'plain' | 'code' | 'data' | 'doc' | 'sheet' | 'image' | 'media' | 'archive'

export interface FilesIconSpec {
  Icon: LucideIcon
  tone: FilesIconTone
}

const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'lua', 'r', 'sql', 'graphql', 'gql', 'vue', 'svelte',
  'astro', 'css', 'scss', 'less', 'html', 'htm', 'xhtml', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env'
])
const DOC = new Set(['md', 'markdown', 'mdx', 'txt', 'log', 'rst', 'tex', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'epub'])
const SHEET = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif'])
const VIDEO = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ogv'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'wma'])
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz'])
const DATA = new Set(['jsonl', 'parquet', 'db', 'sqlite', 'sqlite3'])

export function filesIconSpec(name: string): FilesIconSpec {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (DATA.has(ext)) return { Icon: Database, tone: 'data' }
  if (ext === 'json' || ext === 'jsonc') return { Icon: FileJson, tone: 'data' }
  if (CODE.has(ext)) return { Icon: FileCode, tone: 'code' }
  if (SHEET.has(ext)) return { Icon: FileSpreadsheet, tone: 'sheet' }
  if (IMAGE.has(ext)) return { Icon: FileImage, tone: 'image' }
  if (AUDIO.has(ext)) return { Icon: FileAudio, tone: 'media' }
  if (VIDEO.has(ext)) return { Icon: FileVideo, tone: 'media' }
  if (ARCHIVE.has(ext)) return { Icon: FileArchive, tone: 'archive' }
  if (DOC.has(ext)) return { Icon: FileText, tone: 'doc' }
  return { Icon: File, tone: 'plain' }
}
