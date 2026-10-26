import type { ReactElement } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, CircleEllipsis } from 'lucide-react'
import type { Lang } from '../../i18n'
import type { TodoRowKind, TodoTileModel } from './todo-tile-model'
import './todo-tile.css'

export interface TodoTileText {
  done: string
  running: string
  blocked: string
  pending: string
}

const ZH: TodoTileText = { done: '已完成', running: '进行中', blocked: '受阻', pending: '待做' }
const EN: TodoTileText = { done: 'Done', running: 'In progress', blocked: 'Blocked', pending: 'Pending' }

export function todoTileText(lang: Lang): TodoTileText {
  return lang === 'en-US' ? EN : ZH
}

function RowMark({ kind }: { kind: TodoRowKind }): ReactElement {
  if (kind === 'done') return <CircleCheck size={14} aria-hidden />
  if (kind === 'running') return <CircleEllipsis size={14} aria-hidden />
  if (kind === 'blocked') return <CircleAlert size={14} aria-hidden />
  return <CircleDashed size={14} aria-hidden />
}

export function TodoTileRows({
  model,
  text,
  anchorIndex = model.activeIndex,
  markAnchorRow
}: {
  model: TodoTileModel
  text: TodoTileText
  anchorIndex?: number
  markAnchorRow?: (el: HTMLLIElement | null) => void
}): ReactElement {
  return (
    <ul className="v3-todo-list">
      {model.rows.map((row) => (
        <li
          key={row.index}
          ref={row.index === anchorIndex ? markAnchorRow : undefined}
          className="v3-todo-row"
          data-kind={row.kind}
          data-testid="v3-todo-row"
          title={row.text}
        >
          <span className="v3-todo-mark" title={text[row.kind]} aria-label={text[row.kind]}>
            <RowMark kind={row.kind} />
          </span>
          <span className="v3-todo-text">{row.text}</span>
        </li>
      ))}
    </ul>
  )
}
