/**
 * 侧栏底部的待办磁贴容器。
 *
 * 数据只有一个来源：`store.todos` —— 主进程按 `belongsToView` 只把**当前主视图
 * 会话**的清单投影到顶层（后台会话的在 `sessionRuntimes` 各自键下）。所以这里
 * 不接子代理、不合并别的会话，也不另开数据通道。
 *
 * 折叠状态按会话 id 记在组件内存在，不写设置、不持久化；会话切换时以会话 id
 * 为键，各自保留各自的折叠。当前会话没有待办时 `TodoTileView` 返回 null，
 * 整块不占高度。
 */
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
  /* 折叠按会话认人：优先「已经铺上的」peek 身份，避免切换在途时把折叠记到上一条 */
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
