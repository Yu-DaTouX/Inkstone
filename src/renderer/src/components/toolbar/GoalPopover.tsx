import { useEffect, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { shortTitle } from '../../../../shared/short-title'
import { useStore } from '../../state/store'
import { goalDisplayTitle } from '../../state/goal-view'
import { GoalContent } from './GoalSection'

export function GoalPopover() {
  const t = useT()
  const goal = useStore((s) => s.goal)
  const goalError = useStore((s) => s.goalError)
  const open = useStore((s) => s.goalPopoverOpen)
  const setOpen = useStore((s) => s.setGoalPopoverOpen)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    return acquireOverlayBlocker('goal-popover')
  }, [open, acquireOverlayBlocker])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open, setOpen])

  const hasContent = Boolean(goal?.goalId || goal?.pendingReady)
  const active = hasContent ? goal : null
  const steps = active?.steps ?? []
  const done = steps.filter((step) => step.status === 'done').length
  const displayTitle = goalDisplayTitle(active)
  const label = shortTitle(displayTitle, 22)

  const sessionKey = useStore((s) => s.session?.conversationFile ?? s.session?.sessionFile)
  useEffect(() => {
    setOpen(false)
  }, [sessionKey, setOpen])

  if (!active && !goalError && !open) return null

  return (
    <div className="goal-entry-wrap" ref={rootRef}>
      {active || goalError ? (
      <button
        type="button"
        className={`goal-entry ${active ? `goal-${active.phase}` : ''} ${open ? 'on' : ''}`}
        data-testid="goal-entry"
        data-goal-phase={active?.phase ?? 'empty'}
        aria-expanded={open}
        title={displayTitle || t('goal.title')}
        onClick={() => setOpen(!open)}
      >
        <Icon name="checklist" size={14} />
        <span className="goal-entry-label">{label.short || t('goal.title')}</span>
        {active && steps.length ? (
          <span className="goal-entry-count" data-testid="goal-entry-count">
            {done}/{steps.length}
          </span>
        ) : null}
      </button>
      ) : null}

      {open ? (
        <div className="goal-popover" role="dialog" aria-label={t('goal.title')} data-testid="goal-popover">
          <GoalContent />
        </div>
      ) : null}
    </div>
  )
}
