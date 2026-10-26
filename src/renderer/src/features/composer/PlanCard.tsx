import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { activeTodoRow, buildTodoTileModel, hasTodoTileContent } from '../todos/todo-tile-model'
import { TodoTileRows, todoTileText } from '../todos/TodoTileView'
import './plan-card.css'

const NARROW_WIDTH = 520

export function PlanCard(): ReactElement | null {
  const t = useT()
  const { lang } = useI18n()
  const rowText = useMemo(() => todoTileText(lang), [lang])

  const todos = useStore((s) => s.todos)
  const todoHistory = useStore((s) => s.todoHistory)
  const agentRunning = useStore((s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true)
  const userMessageCount = useStore((s) => s.messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0))

  const model = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])
  const activeRow = activeTodoRow(model)

  const latestRound = todoHistory.length ? todoHistory[todoHistory.length - 1].round : null
  const stale = latestRound !== null && userMessageCount > latestRound

  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const rootObserverRef = useRef<ResizeObserver | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRowRef = useRef<HTMLLIElement | null>(null)
  const markActiveRow = useCallback((el: HTMLLIElement | null) => {
    activeRowRef.current = el
  }, [])
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    rootObserverRef.current?.disconnect()
    rootObserverRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(width > 0 && width < NARROW_WIDTH)
    })
    observer.observe(el)
    rootObserverRef.current = observer
  }, [])

  const collapsed = manualCollapsed ?? narrow

  useLayoutEffect(() => {
    const el = scrollRef.current
    setOverflowing(!!el && el.scrollHeight - el.clientHeight > 1)
  }, [model.rows.length, collapsed])

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [model.activeIndex, collapsed, todos])

  if (!hasTodoTileContent(todos)) return null
  if (model.total > 0 && model.done >= model.total) return null

  const headline = stale ? t('plan.stale') : t('plan.title', { done: model.done, total: model.total })
  const collapsedLabel = activeRow ? `${headline} · ${t('plan.workingOn', { text: activeRow.text })}` : headline

  return (
    <div className="plan-card" data-testid="plan-card" ref={rootRef}>
      <button
        type="button"
        className="plan-card-head"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('plan.expand') : t('plan.collapse')}
        data-testid="plan-card-toggle"
        onClick={() => setManualCollapsed(!collapsed)}
      >
        <span className="plan-card-title">{collapsed ? collapsedLabel : headline}</span>
        {collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
      </button>
      {collapsed ? null : (
        <div className="plan-card-scroll" ref={scrollRef} data-testid="plan-card-scroll" data-overflow={overflowing}>
          <TodoTileRows model={model} text={rowText} markActiveRow={markActiveRow} />
        </div>
      )}
    </div>
  )
}
