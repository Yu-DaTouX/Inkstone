import type { ReactElement, ReactNode } from 'react'
import { MiddleTruncate } from '../../ui'
import type { GitFileStatus } from '../../../../shared/git'
import { fileStatusLabel, porcelainFileStatus } from '../../lib/file-status'
import type { ChangeItem } from './types'
import type { ChangesText } from './text'
import { distinctChangeDirs } from './file-list'

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

export function ChangeStatusMark({ item, lang, text }: { item: ChangeItem; lang?: string; text: ChangesText }): ReactElement {
  const status = porcelainFileStatus(item.status)
  const label =
    status === 'renamed' && item.origPath ? `${fileStatusLabel(status, lang)} · ${text.fileRenamed(item.origPath)}` : fileStatusLabel(status, lang)
  return (
    <span className="changes-status ui-num" data-status={status} role="img" aria-label={label} title={label}>
      {STATUS_LETTER[status]}
    </span>
  )
}

export function ChangePathLabel({ path, dir, mark }: { path: string; dir?: string; mark?: ReactNode }): ReactElement {
  const { name } = splitChangePath(path)
  const shown = dir ?? distinctChangeDirs([path]).get(path) ?? ''
  return (
    <span className="changes-path" title={path}>
      {mark}
      <span className="changes-path__name">{name}</span>
      {shown ? <MiddleTruncate value={shown} showTitle={false} className="changes-path__dir ui-meta-num" /> : null}
    </span>
  )
}
