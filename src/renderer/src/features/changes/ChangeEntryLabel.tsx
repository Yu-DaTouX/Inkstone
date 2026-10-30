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

const ELIDED_DIR = '\u2026/'

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
  const elided = shown.startsWith(ELIDED_DIR)
  const visible = elided ? shown.slice(1) : shown
  return (
    <span className="changes-path" title={path}>
      {mark}
      <span className="changes-path__name">{name}</span>
      {visible ? (
        <span className="changes-path__where">
          {elided ? <span className="changes-path__elide" aria-hidden="true">{'\u2026'}</span> : null}
          <MiddleTruncate value={visible} showTitle={false} className="changes-path__dir ui-meta-num" />
        </span>
      ) : null}
    </span>
  )
}
