import {
  Braces,
  FileCode2,
  FileImage,
  FileLock2,
  FileText,
  Folder,
  type LucideIcon,
  Settings2,
  SquareTerminal
} from 'lucide-react'
import { memo } from 'react'
import { cn } from '@/t3/lib/utils'

const ICON_BY_EXTENSION: Record<string, LucideIcon> = {
  bash: SquareTerminal,
  css: Braces,
  env: Settings2,
  gif: FileImage,
  html: FileCode2,
  ico: FileImage,
  jpeg: FileImage,
  jpg: FileImage,
  js: FileCode2,
  json: Braces,
  jsonc: Braces,
  jsx: FileCode2,
  lock: FileLock2,
  md: FileText,
  mdx: FileText,
  png: FileImage,
  scss: Braces,
  sh: SquareTerminal,
  svg: FileImage,
  toml: Settings2,
  ts: FileCode2,
  tsx: FileCode2,
  txt: FileText,
  webp: FileImage,
  yaml: Settings2,
  yml: Settings2,
  zsh: SquareTerminal
}

export function fileEntryIcon(pathValue: string, kind: 'file' | 'directory' = 'file'): LucideIcon {
  if (kind === 'directory') return Folder
  const name = pathValue.slice(
    Math.max(pathValue.lastIndexOf('/'), pathValue.lastIndexOf('\\')) + 1
  )
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return ICON_BY_EXTENSION[extension] ?? FileText
}

export const FileEntryIcon = memo(function FileEntryIcon(props: {
  pathValue: string
  kind?: 'file' | 'directory'
  className?: string
}) {
  const Icon = fileEntryIcon(props.pathValue, props.kind ?? 'file')
  return <Icon aria-hidden className={cn('size-4 shrink-0 text-icon-muted', props.className)} />
})
