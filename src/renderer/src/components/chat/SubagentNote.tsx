import { useEffect } from 'react'
import { useStore } from '../../state/store'

/**
 * 子代理列表的加载入口（不渲染任何东西）。
 *
 * 子代理的显示在两处：触发它的那条助手消息下面（`TurnSubagents`），
 * 和右栏「任务」分区里（`TodoSection`）。挂载时拉一次，重开应用后仍能看到
 * 本进程里在跑的子代理；之后靠推送更新。
 */
export function SubagentNote() {
  const loadSubagents = useStore((s) => s.loadSubagents)
  useEffect(() => {
    void loadSubagents()
  }, [loadSubagents])
  return null
}
