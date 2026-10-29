import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Clock, Layers, MoreHorizontal, Users, type LucideIcon } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useRunsV3 } from '../../state/runs-v3'
import { IconButton, ListRow, Menu, MenuItem, Popover, StatusDot, StatusSlot } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { collabText } from '../collab/collab-text'
import { usePendingPairInvite } from '../collab/pending-invite'
import { sidebarText } from './sidebar-text'
import { activeRunCount, SIDE_MORE_ORDER, sideMoreEntries, sideMoreLayout, type SideMoreEntry, type SideMoreId } from './side-more'

interface SideMoreProps {
  route: string
  onSchedule?: () => void
  onCollab?: () => void
  onArtifacts?: () => void
  compact?: boolean
}

interface EntryMeta {
  label: string
  Icon: LucideIcon
  testId: string
}

function useSchedulePendingApproval(enabled: boolean, route: string, activeRuns: number): boolean {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const bridge = enabled ? window.yan?.schedule : undefined
    if (!bridge) return undefined
    let alive = true
    void bridge
      .list()
      .then((tasks) => {
        if (alive) setPending(tasks.some((task) => task.pendingApproval === true))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [enabled, route, activeRuns])
  return pending
}

export function SideMore({ route, onSchedule, onCollab, onArtifacts, compact }: SideMoreProps): ReactElement | null {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const runs = useRunsV3((s) => s.runs)
  const invitePending = usePendingPairInvite((s) => s.invite !== null)
  const activeRuns = useMemo(() => activeRunCount(runs), [runs])
  const pendingApproval = useSchedulePendingApproval(!!onSchedule, route, activeRuns)
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)

  const handlers: Record<SideMoreId, (() => void) | undefined> = { schedule: onSchedule, collab: onCollab, artifacts: onArtifacts }
  const meta: Record<SideMoreId, EntryMeta> = {
    schedule: { label: text.schedule, Icon: Clock, testId: 'v3-schedule-entry' },
    collab: { label: collabText(lang).nav, Icon: Users, testId: 'v3-collab-entry' },
    artifacts: { label: t('artifactLibrary.title'), Icon: Layers, testId: 'v3-artifacts-entry' }
  }
  const available = new Set(SIDE_MORE_ORDER.filter((id) => !!handlers[id]))
  const entries = sideMoreEntries({ available, schedulePendingApproval: pendingApproval, pairInvitePending: invitePending, runs })
  const layout = sideMoreLayout(entries, route)

  const renderRow = ({ id, attention }: SideMoreEntry): ReactElement => {
    const { label, Icon, testId } = meta[id]
    return (
      <ListRow
        key={id}
        icon={<Icon size={16} />}
        trailing={
          attention ? (
            <StatusSlot label={attention === 'awaiting' ? own.entryAwaiting : own.entryRunning}>
              <StatusDot kind={attention === 'awaiting' ? 'awaiting' : 'running'} />
            </StatusSlot>
          ) : null
        }
        onClick={handlers[id]}
        aria-current={route === id ? 'page' : undefined}
        data-testid={testId}
      >
        {label}
      </ListRow>
    )
  }

  if (compact) {
    const attention = entries.find((entry) => entry.attention)?.attention
    const current = entries.some((entry) => entry.id === route)
    return (
      <>
        <IconButton
          ref={moreRef}
          aria-label={text.more}
          tooltip={text.more}
          aria-haspopup="menu"
          className="v3-side-more-btn"
          data-selected={current ? '' : undefined}
          onPress={() => setOpen(true)}
          data-testid="v3-side-more"
        >
          <MoreHorizontal size={18} />
          {attention ? (
            <StatusSlot className="v3-side-more-mark" label={attention === 'awaiting' ? own.entryAwaiting : own.entryRunning}>
              <StatusDot kind={attention === 'awaiting' ? 'awaiting' : 'running'} />
            </StatusSlot>
          ) : null}
        </IconButton>
        <Popover triggerRef={moreRef} isOpen={open} onOpenChange={setOpen} placement="bottom end" offset={4}>
          <Menu
            aria-label={text.more}
            autoFocus="first"
            onAction={(key) => {
              setOpen(false)
              handlers[key as SideMoreId]?.()
            }}
            onClose={() => setOpen(false)}
            data-testid="v3-side-more-menu"
          >
            {entries.map(({ id, attention: mark }) => {
              const { label, Icon, testId } = meta[id]
              return (
                <MenuItem
                  key={id}
                  id={id}
                  textValue={label}
                  icon={<Icon size={14} />}
                  data-testid={testId}
                >
                  {label}
                  {mark ? <StatusDot kind={mark === 'awaiting' ? 'awaiting' : 'running'} /> : null}
                </MenuItem>
              )
            })}
          </Menu>
        </Popover>
      </>
    )
  }

  return (
    <>
      {layout.shown.map(renderRow)}
      {layout.folded.length > 0 ? (
        <>
          <ListRow
            ref={moreRef}
            icon={<MoreHorizontal size={16} />}
            aria-haspopup="menu"
            aria-expanded={open}
            data-menu={open ? '1' : undefined}
            data-selected={layout.foldedCurrent ? '' : undefined}
            onClick={() => setOpen(true)}
            data-testid="v3-side-more"
          >
            {text.more}
          </ListRow>
          <Popover triggerRef={moreRef} isOpen={open} onOpenChange={setOpen} placement="bottom start" offset={4}>
            <Menu
              aria-label={text.more}
              autoFocus="first"
              onAction={(key) => {
                setOpen(false)
                handlers[key as SideMoreId]?.()
              }}
              onClose={() => setOpen(false)}
              data-testid="v3-side-more-menu"
            >
              {layout.folded.map(({ id }) => {
                const { label, Icon, testId } = meta[id]
                return (
                  <MenuItem key={id} id={id} textValue={label} icon={<Icon size={14} />} data-testid={testId}>
                    {label}
                  </MenuItem>
                )
              })}
            </Menu>
          </Popover>
        </>
      ) : null}
    </>
  )
}
