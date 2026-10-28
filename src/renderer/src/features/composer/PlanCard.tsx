import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { activeTodoRow, anchorTodoIndex, buildTodoTileModel, hasTodoTileContent } from '../todos/todo-tile-model'
import { TodoTileRows, todoTileText } from '../todos/TodoTileView'
import './plan-card.css'

const PLAN_EXPANDED_STORAGE_KEY = 'inkstone.v3.planCard.expanded'

function readExpanded(): boolean {
  try {
    return localStorage.getItem(PLAN_EXPANDED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(PLAN_EXPANDED_STORAGE_KEY, expanded ? '1' : '0')
  } catch {
  }
}

function hidesRowsBelow(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop > 1
}

export function PlanCard(): ReactElement | null {
  const t = useT()
  const { lang } = useI18n()
  const rowText = useMemo(() => todoTileText(lang), [lang])
  const listId = useId()

  const todos = useStore((s) => s.todos)
  const todoHistory = useStore((s) => s.todoHistory)
  const agentRunning = useStore((s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true)
  const userMessageCount = useStore((s) => (s.todoHistory.length ? s.messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0) : 0))

  const model = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])
  const activeRow = activeTodoRow(model)
  const anchorIndex = anchorTodoIndex(model)

  const latestRound = todoHistory.length ? todoHistory[todoHistory.length - 1].round : null
  const stale = latestRound !== null && userMessageCount > latestRound

  const [expanded, setExpanded] = useState(readExpanded)
  const [overflowing, setOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const anchorRowRef = useRef<HTMLLIElement | null>(null)
  const markAnchorRow = useCallback((el: HTMLLIElement | null) => {
    anchorRowRef.current = el
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const row = anchorRowRef.current
    if (row) el.scrollTop = Math.max(0, row.offsetTop - row.offsetHeight)
    setOverflowing(hidesRowsBelow(el))
  }, [anchorIndex, model.rows.length, expanded, todos])

  if (!hasTodoTileContent(todos)) return null
  if (model.total > 0 && model.done >= model.total) return null

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    writeExpanded(next)
  }

  const headline = t('plan.title', { done: model.done, total: model.total })
  const nowText = !expanded && !stale && activeRow ? activeRow.text : ''
  const hint = expanded ? t('plan.collapse') : nowText ? t('plan.workingOn', { text: nowText }) : t('plan.expand')

  return (
    <div className="plan-card" data-testid="plan-card" data-expanded={expanded}>
      <button
        type="button"
        className="plan-card-head"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        title={hint}
        data-testid="plan-card-toggle"
        onClick={toggle}
      >
        <span className="plan-card-title">
          <span className="plan-card-count">{headline}</span>
          {stale ? <span className="plan-card-stale">{t('plan.stale')}</span> : null}
          {nowText ? <span className="plan-card-now">{nowText}</span> : null}
        </span>
        {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </button>
      {expanded ? (
        <div
          id={listId}
          className="plan-card-scroll"
          ref={scrollRef}
          data-testid="plan-card-scroll"
          data-overflow={overflowing}
          onScroll={(event) => setOverflowing(hidesRowsBelow(event.currentTarget))}
        >
          <TodoTileRows model={model} text={rowText} anchorIndex={anchorIndex} markAnchorRow={markAnchorRow} />
        </div>
      ) : null}
    </div>
  )
}
