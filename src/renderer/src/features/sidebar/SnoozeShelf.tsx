import { useState, type JSX } from 'react'
import { AlarmClock } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { Collapsible, CollapsibleHeader, Expand } from '../../ui'
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
      <Collapsible isExpanded={open} onExpandedChange={setOpen}>
        <CollapsibleHeader
          chevron="end"
          rule
          icon={<AlarmClock size={12} />}
          accessory={rows.length}
         
          data-testid="v3-snooze-toggle"
        >
          {t('rail.snoozedGroup')}
        </CollapsibleHeader>
        <Expand open={open}>
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
                  onOpen={onOpen}
                />
              )
            })}
          </div>
        </Expand>
      </Collapsible>
    </section>
  )
}
