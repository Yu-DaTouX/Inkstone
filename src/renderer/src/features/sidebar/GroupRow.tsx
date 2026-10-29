import { memo, useMemo, type JSX } from 'react'
import { useI18n } from '../../i18n'
import type { SessionSummary } from '../../../../shared/ipc'
import type { ArchiveShelfRow } from './ArchiveShelf'
import { SidebarRow } from './SidebarRow'
import { sessionRowMeta } from './sidebar-model'

export const GroupRow = memo(function GroupRow({ row, now, twin, onOpen }: { row: ArchiveShelfRow; now: number; twin: boolean; onOpen: (item: SessionSummary) => void }): JSX.Element {
  const { lang } = useI18n()
  const live = row.status === 'running' || row.status === 'awaiting'
  const meta = useMemo(() => sessionRowMeta(row.item, { now, lang, since: row.since, live, twin }), [row.item, now, lang, row.since, live, twin])
  return (
    <SidebarRow
      item={row.item}
      title={row.title}
      isCurrent={row.isCurrent}
      status={row.status}
      code={row.code}
      meta={meta}
      onOpen={onOpen}
    />
  )
})
