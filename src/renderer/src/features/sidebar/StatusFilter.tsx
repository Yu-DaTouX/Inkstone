import { AlertCircle, Check, CircleDot, Inbox, ListFilter, Loader, MailOpen } from '../../ui/icons'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { Dialog, ListRow, Popover } from '../../ui'
import { SidebarHeaderIconButton } from '../../t3/components/sidebar/SidebarThreadHeader'
import type { RowStatus } from '../../t3/adapters/sidebar'
import type { SidebarThreadView } from '../../t3/adapters/sidebar/types'
import './new-session-picker.css'

export type SessionStatusFilter = 'unread' | 'working' | 'attention' | 'failed'

export function matchesStatusFilter(filter: SessionStatusFilter, view: SidebarThreadView, status: RowStatus): boolean {
  if (filter === 'unread') return view.unread
  if (filter === 'working') return status === 'working'
  if (filter === 'attention') return status === 'approval' || status === 'input'
  return status === 'failed'
}

const OPTIONS: ReadonlyArray<{ value: SessionStatusFilter | null; icon: ReactNode; text: string }> = [
  { value: null, icon: <Inbox size={15} />, text: 'all' },
  { value: 'unread', icon: <MailOpen size={15} />, text: 'unread' },
  { value: 'working', icon: <Loader size={15} />, text: 'working' },
  { value: 'attention', icon: <CircleDot size={15} />, text: 'attention' },
  { value: 'failed', icon: <AlertCircle size={15} />, text: 'failed' }
]

interface Props {
  value: SessionStatusFilter | null
  onChange: (value: SessionStatusFilter | null) => void
}

export function StatusFilter({ value, onChange }: Props): ReactElement {
  const t = useT()
  const anchorRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const label = value === null ? t('sidebar.t3.statusFilter.label') : t('sidebar.t3.statusFilter.active', { name: t(`sidebar.t3.statusFilter.${value}`) })
  return (
    <>
      <SidebarHeaderIconButton
        label={label}
        data-active={value !== null ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="v3-status-filter"
        onPress={(event) => {
          anchorRef.current = event.target as HTMLElement
          setOpen(true)
        }}
      >
        <ListFilter />
      </SidebarHeaderIconButton>
      <Popover variant="panel" className="new-session-picker" triggerRef={anchorRef} isOpen={open} onOpenChange={setOpen} placement="bottom start" offset={6}>
        <Dialog aria-label={t('sidebar.t3.statusFilter.label')} showClose={false} body="flush">
          {() => (
            <div className="nsp" data-testid="v3-status-filter-panel">
              <div className="nsp__list" role="listbox" aria-label={t('sidebar.t3.statusFilter.label')}>
                {OPTIONS.map((option) => (
                  <ListRow
                    key={option.text}
                    role="option"
                    aria-selected={option.value === value}
                    className="nsp__option"
                    icon={option.icon}
                    trailing={option.value === value ? <Check size={14} aria-label={t('sidebar.t3.filter.current')} /> : null}
                    onClick={() => {
                      setOpen(false)
                      onChange(option.value)
                    }}
                    data-testid={`v3-status-filter-${option.text}`}
                  >
                    {t(option.value === null ? 'sidebar.t3.statusFilter.all' : `sidebar.t3.statusFilter.${option.value}`)}
                  </ListRow>
                ))}
              </div>
            </div>
          )}
        </Dialog>
      </Popover>
    </>
  )
}
