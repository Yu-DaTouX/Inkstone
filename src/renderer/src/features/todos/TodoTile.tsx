import { useState, type ReactElement } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { hasTodoTileContent, toggleTodoTileFold, type TodoTileFolds } from './todo-tile-model'
import { TodoTileView } from './TodoTileView'
import './todo-tile.css'

export function TodoTile(): ReactElement | null {
  const { lang } = useI18n()
  const todos = useStore((s) => s.todos)
  const agentRunning = useStore((s) => s.session?.isAgentRunning === true || s.session?.isStreaming === true)
  const sessionId = useStore((s) => s.peekedSessionId ?? s.session?.sessionId ?? '')
  const [foldMap, setFoldMap] = useState<TodoTileFolds>({})

  if (!hasTodoTileContent(todos)) return null

  return (
    <TodoTileView
      todos={todos}
      agentRunning={agentRunning}
      sessionId={sessionId}
      foldMap={foldMap}
      onToggleFold={(id) => setFoldMap((prev) => toggleTodoTileFold(prev, id))}
      lang={lang}
    />
  )
}
