import { useEffect, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { shortTitle } from '../../../../shared/short-title'
import { useStore } from '../../state/store'
import { GoalContent } from './GoalSection'

/**
 * 目标浮层（实施-12 U-3a）。
 *
 * 目标从「工具页里常驻的一块」改成**标题栏入口 + 浮层**：
 *   · 入口只占一行，显示短标题与进度，不再抢工具页的位置；
 *   · 内容复用 `GoalContent`（只读，点击查看不会创建/停止目标）；
 *   · 打开期间领一个 overlay blocker，原生网页让位（H-9a 协调器）。
 *
 * 关闭不修改目标状态；重试走 `loadGoal`。
 */
export function GoalPopover() {
  const t = useT()
  const goal = useStore((s) => s.goal)
  const open = useStore((s) => s.goalPopoverOpen)
  const setOpen = useStore((s) => s.setGoalPopoverOpen)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const rootRef = useRef<HTMLDivElement>(null)

  /* 打开时领自己的 blocker，关闭只释放自己的（原生网页显隐唯一协调点在 store） */
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

  const active = goal?.goalId ? goal : null
  const steps = active?.steps ?? []
  const done = steps.filter((step) => step.status === 'done').length
  const label = shortTitle(active?.brief?.goal || active?.goalId, 22)

  return (
    <div className="goal-entry-wrap" ref={rootRef}>
      <button
        type="button"
        className={`goal-entry ${active ? `goal-${active.phase}` : ''} ${open ? 'on' : ''}`}
        data-testid="goal-entry"
        data-goal-phase={active?.phase ?? 'empty'}
        aria-expanded={open}
        title={active?.brief?.goal ?? t('goal.title')}
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

      {open ? (
        <div className="goal-popover" role="dialog" aria-label={t('goal.title')} data-testid="goal-popover">
          <GoalContent />
        </div>
      ) : null}
    </div>
  )
}
