import type { ReactElement, ReactNode } from 'react'
import type { GitFileStatus } from '../../../../shared/git'
import { fileStatusLabel, porcelainFileStatus } from '../../lib/file-status'
import type { ChangeItem } from './types'
import type { ChangesText } from './text'

const STATUS_LETTER: Record<GitFileStatus, string> = {
  added: 'A',
  untracked: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  unmerged: 'U'
}

export function splitChangePath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

export function shortChangeDir(dir: string, keep = 2): string {
  const parts = dir.split('/').filter(Boolean)
  return parts.length <= keep ? parts.join('/') : `\u2026/${parts.slice(-keep).join('/')}`
}

export function ChangeStatusMark({ item, lang, text }: { item: ChangeItem; lang?: string; text: ChangesText }): ReactElement {
  const status = porcelainFileStatus(item.status)
  const label =
    status === 'renamed' && item.origPath ? `${fileStatusLabel(status, lang)} · ${text.fileRenamed(item.origPath)}` : fileStatusLabel(status, lang)
  return (
    <span className="changes-status" data-status={status} role="img" aria-label={label} title={label}>
      {STATUS_LETTER[status]}
    </span>
  )
}

export function ChangePathLabel({ path, mark }: { path: string; mark?: ReactNode }): ReactElement {
  const { name, dir } = splitChangePath(path)
  return (
    <span className="changes-path" title={path}>
      {mark}
      <span className="changes-path__name">{name}</span>
      {dir ? <span className="changes-path__dir">{`\u200e${shortChangeDir(dir)}\u200e`}</span> : null}
    </span>
  )
}
