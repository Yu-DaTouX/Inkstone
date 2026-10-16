import type { ReactElement } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert } from 'lucide-react'
import { Spinner } from '../../ui'
import type { Lang } from '../../i18n'
import type { SessionTodo } from '../../../../shared/ipc'
import { buildTodoTileModel, hasTodoTileContent, isTodoTileFolded, type TodoTileFolds, type TodoTileModel } from './todo-tile-model'
import './todo-tile.css'

export interface TodoTileText {
  title: string
  running: string
  blocked: string
}

const ZH: TodoTileText = { title: '待办', running: '正在进行', blocked: '受阻' }
const EN: TodoTileText = { title: 'Todos', running: 'In progress', blocked: 'Blocked' }

export function todoTileText(lang: Lang): TodoTileText {
  return lang === 'en-US' ? EN : ZH
}

export interface TodoTileViewProps {
  todos: readonly SessionTodo[]
  agentRunning: boolean
  sessionId: string
  foldMap: TodoTileFolds
  onToggleFold: (sessionId: string) => void
  lang: Lang
}

export function TodoTileView({
  todos,
  agentRunning,
  sessionId,
  foldMap,
  onToggleFold,
  lang
}: TodoTileViewProps): ReactElement | null {
  if (!hasTodoTileContent(todos)) return null
  const text = todoTileText(lang)
  const model = buildTodoTileModel(todos, agentRunning)
  const folded = isTodoTileFolded(foldMap, sessionId)
  return (
    <section className="v3-todo" data-testid="v3-todo" data-folded={folded ? '1' : '0'}>
      <button
        type="button"
        className="v3-todo-head"
        aria-expanded={!folded}
        onClick={() => onToggleFold(sessionId)}
        data-testid="v3-todo-toggle"
      >
        {folded ? <ChevronRight className="v3-todo-chev" size={14} aria-hidden /> : <ChevronDown className="v3-todo-chev" size={14} aria-hidden />}
        <span className="v3-todo-title">{text.title}</span>
        <span className="v3-todo-count" data-testid="v3-todo-count">
          {model.done}/{model.total}
        </span>
      </button>
      {folded ? null : <TodoTileRows model={model} text={text} />}
    </section>
  )
}

export function TodoTileRows({ model, text }: { model: TodoTileModel; text: TodoTileText }): ReactElement {
  return (
    <div className="v3-todo-scroll" data-testid="v3-todo-scroll">
      <ul className="v3-todo-list">
        {model.rows.map((row) => (
          <li key={row.index} className="v3-todo-row" data-kind={row.kind} data-testid="v3-todo-row" title={row.text}>
            <span className="v3-todo-mark">
              {row.kind === 'done' ? <Check size={12} aria-hidden /> : null}
              {row.kind === 'running' ? <Spinner size={12} label={text.running} /> : null}
              {row.kind === 'blocked' ? <CircleAlert size={12} aria-hidden /> : null}
            </span>
            <span className="v3-todo-text">{row.text}</span>
            {row.kind === 'blocked' ? <span className="v3-todo-state">{text.blocked}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
