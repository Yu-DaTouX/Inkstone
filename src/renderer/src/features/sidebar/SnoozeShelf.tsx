import { useState, type JSX } from 'react'
import { AlarmClock, ChevronRight } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import type { SessionSummary } from '../../../../shared/ipc'
import type { ArchiveShelfRow } from './ArchiveShelf'
import { SidebarRow } from './SidebarRow'
import { formatSnoozeWake } from './session-snooze'

export interface SnoozeShelfProps {
  rows: readonly ArchiveShelfRow[]
  now: number
  onOpen: (item: SessionSummary) => void
}

export function SnoozeShelf({ rows, now, onOpen }: SnoozeShelfProps): JSX.Element | null {
  const t = useT()
  const { lang } = useI18n()
  const [open, setOpen] = useState(false)
  if (!rows.length) return null

  return (
    <section
      className="v3-snooze"
      data-open={open ? '1' : undefined}
      aria-label={t('rail.snoozedGroup')}
      data-testid="v3-snooze-shelf"
    >
      <button
        type="button"
        className="v3-snooze-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="v3-snooze-toggle"
      >
        <AlarmClock size={12} aria-hidden />
        <span className="v3-snooze-label">{t('rail.snoozedGroup')}</span>
        <span className="v3-snooze-rule" aria-hidden />
        <span className="v3-snooze-count">{rows.length}</span>
        <ChevronRight className="v3-snooze-chev" size={12} aria-hidden />
      </button>
      {open ? (
        <div className="v3-snooze-list">
          {rows.map((row) => {
            const wake = row.item.snoozedUntil
            const label = typeof wake === 'number' ? formatSnoozeWake(wake, now, lang) : undefined
            return (
              <SidebarRow
                key={row.item.path}
                item={row.item}
                title={row.title}
                isCurrent={row.isCurrent}
                status={row.status}
                code={row.code}
                snoozeLabel={label}
                snoozeTitle={label ? t('rail.snoozeWakeAt', { time: label }) : undefined}
                onOpen={() => onOpen(row.item)}
              />
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
