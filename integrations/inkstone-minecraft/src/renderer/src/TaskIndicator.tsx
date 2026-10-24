import { useEffect, useState, type ReactElement } from 'react'
import { Dialog, DialogTrigger } from 'react-aria-components'
import { X } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { Popover } from '@yan/ui/Popover'
import { MeterRing, ProgressBar } from '@yan/ui/Progress'
import { StatusDot } from '@yan/ui/StatusDot'
import type { TaskInfo, TaskState } from '../../shared/api.ts'

const STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

function percent(task: TaskInfo): number | null {
  return task.progress && task.progress.total > 0 ? Math.min(100, (task.progress.done / task.progress.total) * 100) : null
}

export function useTasks(): [TaskInfo[], () => void] {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const refresh = (): void => void window.craft.tasks().then(setTasks)
  useEffect(() => {
    void window.craft.tasks().then(setTasks)
    return window.craft.onTask((task) =>
      setTasks((current) => {
        const index = current.findIndex((item) => item.id === task.id)
        if (index < 0) return [...current, task]
        const next = [...current]
        next[index] = task
        return next
      })
    )
  }, [])
  return [tasks, refresh]
}

export function TaskIndicator(): ReactElement | null {
  const [tasks, refresh] = useTasks()
  if (tasks.length === 0) return null
  const running = tasks.filter((task) => task.state === 'running' || task.state === 'queued')
  const failed = tasks.some((task) => task.state === 'failed')
  const overall = running.length > 0 ? running.reduce((sum, task) => sum + (percent(task) ?? 0), 0) / running.length : 100

  return (
    <DialogTrigger>
      <Button variant="ghost" size="sm" className="task-indicator" aria-label={running.length > 0 ? `${running.length} 个任务进行中` : '任务'}>
        {running.length > 0 ? <MeterRing value={overall} size={16} strokeWidth={2} aria-label="总进度" /> : <StatusDot kind={failed ? 'fail' : 'ok'} />}
        <span>{running.length > 0 ? `${running.length} 个任务 · ${Math.round(overall)}%` : failed ? '有任务失败' : '任务已完成'}</span>
      </Button>
      <Popover variant="panel" placement="bottom end" className="task-popover">
        <Dialog className="task-popover__dialog" aria-label="任务">
          <div className="task-popover__head">
            <span className="task-popover__title">任务</span>
            {tasks.some((task) => task.state !== 'running' && task.state !== 'queued') ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => void window.craft.clearFinishedTasks().then(refresh)}
              >
                清除已结束
              </Button>
            ) : null}
          </div>
          <ul className="task-list">
            {[...tasks].reverse().map((task) => {
              const value = percent(task)
              const active = task.state === 'running' || task.state === 'queued'
              return (
                <li key={task.id} className="task-row" data-state={task.state}>
                  <div className="task-row__head">
                    <span className="task-row__title">{task.title}</span>
                    <span className="task-row__state">{STATE_LABEL[task.state]}</span>
                    {active ? (
                      <IconButton aria-label={`取消 ${task.title}`} size="sm" onPress={() => void window.craft.cancelTask(task.id)}>
                        <X size={14} />
                      </IconButton>
                    ) : null}
                  </div>
                  {active ? <ProgressBar aria-label={task.title} value={value ?? 0} isIndeterminate={value === null} tone="run" /> : null}
                  {task.error ? <div className="task-row__error">{task.error}</div> : task.detail ? <div className="task-row__detail">{task.detail}</div> : null}
                </li>
              )
            })}
          </ul>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}
