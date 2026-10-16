/**
 * 侧栏待办磁贴的版面件（无 store 依赖，便于 SSR 单测）。
 *
 * 只画 `buildTodoTileModel` 的结果：标题行是折叠开关（原生 button，`aria-expanded`
 * 同步），往下是一个限高、内部滚动的清单。控件外观来自 `ui/` 的 `Spinner` 与
 * lucide 图标，`todo-tile.css` 只管版面与状态色。
 *
 * 一个会话没有待办时返回 null —— 不占高度、不留标题、不给空态。
 */
import type { ReactElement } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert } from 'lucide-react'
import { Spinner } from '../../ui'
import type { Lang } from '../../i18n'
import type { SessionTodo } from '../../../../shared/ipc'
import { buildTodoTileModel, hasTodoTileContent, isTodoTileFolded, type TodoTileFolds, type TodoTileModel } from './todo-tile-model'
// 行样式随行组件走：概览磁贴直接复用 TodoTileRows，不经过 TodoTile 容器
import './todo-tile.css'

export interface TodoTileText {
  title: string
  running: string
  blocked: string
}

const ZH: TodoTileText = { title: '待办', running: '正在进行', blocked: '受阻' }
const EN: TodoTileText = { title: 'Todos', running: 'In progress', blocked: 'Blocked' }

/**
 * 磁贴文案自带一份，不写进 `app/v3-text.ts`（那是 I1 的入口文件，本任务不改）。
 * 外壳定稿后可与其它 v3 文案统一并入。
 */
export function todoTileText(lang: Lang): TodoTileText {
  return lang === 'en-US' ? EN : ZH
}

export interface TodoTileViewProps {
  /** 当前主视图会话的清单 */
  todos: readonly SessionTodo[]
  /** 回合是否真的在跑；无显式 status 的老清单据此推断进行中 */
  agentRunning: boolean
  /** 折叠记忆的会话键；空串 = 这次不落折叠 */
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

/**
 * 清单的行列表（限高、内部滚动）。概览磁贴与旧的独立磁贴共用这一份行渲染。
 */
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
