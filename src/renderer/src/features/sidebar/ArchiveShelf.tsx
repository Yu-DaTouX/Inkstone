import { useState, type JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { SessionSummary } from '../../../../shared/ipc'
import { useSplitDrag } from '../split/split-drag'
import { SidebarRow } from './SidebarRow'
import { sidebarText } from './sidebar-text'
import type { SessionStatusKind } from './session-status'

export const ARCHIVE_SHELF_INITIAL = 10
export const ARCHIVE_SHELF_PAGE = 25
const SHELF_OPEN_KEY = 'inkstone.v3.sidebar.archiveShelfOpen'

function readOpen(): boolean {
  try {
    return localStorage.getItem(SHELF_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(SHELF_OPEN_KEY, open ? '1' : '0')
  } catch {
  }
}

export interface ArchiveShelfRow {
  item: SessionSummary
  title: string
  isCurrent: boolean
  status: SessionStatusKind
  code?: string
}

export function ArchiveShelf({
  rows,
  total,
  onOpen,
  onShowAll
}: {
  rows: readonly ArchiveShelfRow[]
  total: number
  onOpen: (item: SessionSummary) => void
  onShowAll: () => void
}): JSX.Element {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const [open, setOpen] = useState(readOpen)
  const [limit, setLimit] = useState(ARCHIVE_SHELF_INITIAL)
  const dragSource = useSplitDrag((s) => s.source)
  const dragging = !!dragSource?.startsWith('session:')
  const draggingArchived = dragging && rows.some((row) => dragSource === `session:${row.item.path}`)
  const showHint = dragging && !draggingArchived

  const toggle = (): void => {
    setOpen((value) => {
      writeOpen(!value)
      return !value
    })
  }

  const shown = open ? rows.slice(0, limit) : rows.filter((row) => row.isCurrent)
  const hidden = open ? Math.max(0, rows.length - limit) : 0

  return (
    <section
      className="v3-shelf"
      data-archive-shelf
      data-open={open ? '1' : undefined}
      data-dragging={dragging ? '1' : undefined}
      aria-label={own.archiveShelf}
      data-testid="v3-archive-shelf"
    >
      <button
        type="button"
        className="v3-shelf-head"
        aria-expanded={open}
        onClick={toggle}
        data-testid="v3-archive-shelf-toggle"
      >
        <span className="v3-shelf-label">{own.archiveShelf}</span>
        <span className="v3-shelf-rule" aria-hidden />
        <span className="v3-shelf-count">{total}</span>
        <ChevronRight className="v3-shelf-chev" size={12} aria-hidden />
      </button>
      {showHint ? (
        <div className="v3-shelf-drop" aria-hidden>
          {own.archiveShelfDrop}
        </div>
      ) : null}
      {shown.length || open ? (
        <div className="v3-shelf-list">
          {shown.map((row) => (
            <SidebarRow
              key={row.item.path}
              item={row.item}
              title={row.title}
              isCurrent={row.isCurrent}
              status={row.status}
              code={row.code}
              onOpen={() => onOpen(row.item)}
            />
          ))}
          {open && hidden > 0 ? (
            <button type="button" className="ui-row v3-show-more" onClick={() => setLimit((value) => value + ARCHIVE_SHELF_PAGE)} data-testid="v3-archive-shelf-more">
              {own.showMore.replace('{n}', String(Math.min(hidden, ARCHIVE_SHELF_PAGE)))}
            </button>
          ) : null}
          {open ? (
            <button type="button" className="ui-row v3-show-more" onClick={onShowAll} data-testid="v3-archive-all">
              {own.archiveShelfAll}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
