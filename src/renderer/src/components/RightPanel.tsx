import { useMemo } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 右栏 —— 任务进度。
 *
 * 从左侧会话列表里搬过来的。为什么搬：
 *   任务进度是**当前这一轮在干什么**，属于「边聊边看」的信息；
 *   而会话列表是「翻找历史」。两者性质不同，挤在一栏里会互相干扰
 *   （尤其是左栏现在会自动隐藏，任务跟着一起消失就看不见了）。
 *
 * 数据来自会话里的 `custom` entry（见 main/agent.ts 的 todosFromEntries），
 * 与 TUI 的 `/panel` 看的是同一份。
 *
 * 没有任务时整栏自动收起 —— 不能为一个空列表常驻占 264px。
 */
export function RightPanel() {
  const t = useT()
  const todos = useStore((s) => s.todos)

  const done = useMemo(() => todos.filter((x) => x.done).length, [todos])
  const pct = todos.length ? (done / todos.length) * 100 : 0

  // 没有任务就不占位（宽度由 CSS 的 data-empty 控制）
  if (todos.length === 0) return null

  return (
    <aside className="rightpanel" data-testid="rightpanel">
      <div className="rp-head">
        <Icon name="checklist" size={12} />
        <span className="rp-title">{t('rail.tasks')}</span>
        <span className="spacer" />
        <span className="rp-count">
          {done}/{todos.length}
        </span>
      </div>

      {/* 总进度：有 4 个以上任务时才有意义 */}
      {todos.length >= 4 ? (
        <div className="rp-meter" title={`${pct.toFixed(0)}%`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      <div className="rp-list">
        {todos.map((todo, i) => (
          <div key={i} className={`rp-todo ${todo.done ? 'done' : ''}`}>
            <span className="rp-box">{todo.done ? '✓' : ''}</span>
            <span className="rp-text">{todo.text}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
