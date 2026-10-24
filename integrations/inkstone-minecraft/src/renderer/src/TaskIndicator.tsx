import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Dialog, DialogTrigger } from 'react-aria-components'
import { X } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'
import { Popover } from '@yan/ui/Popover'
import { MeterRing, ProgressBar } from '@yan/ui/Progress'
import { StatusDot } from '@yan/ui/StatusDot'
import type { TaskInfo } from '../../shared/api.ts'
import { TASK_STATE_LABEL, taskPercent, taskProgressLabel } from './labels.ts'

const KEEP_FINISHED = 20

function clockLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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
  const running = useMemo(() => tasks.filter((task) => task.state === 'running' || task.state === 'queued'), [tasks])
  const failed = useMemo(() => tasks.filter((task) => task.state === 'failed'), [tasks])
  const finished = tasks.length - running.length
  const overall = running.length > 0 ? running.reduce((sum, task) => sum + (taskPercent(task) ?? 0), 0) / running.length : 100
  const summary =
    running.length > 0
      ? `${running.length} 个任务 · ${Math.round(overall)}%${failed.length > 0 ? `，${failed.length} 个失败` : ''}`
      : failed.length > 0
        ? `${failed.length} 个任务失败`
        : '任务已完成'

  if (tasks.length === 0) {
    return (
      <span className="sr-only" aria-live="polite">
        没有进行中的任务
      </span>
    )
  }

  return (
    <>
      <DialogTrigger>
        <Button variant="ghost" size="sm" className="task-indicator" aria-label={`任务中心：${summary}`}>
          {running.length > 0 ? <MeterRing value={overall} size={16} strokeWidth={2} aria-label="总进度" /> : <StatusDot kind={failed.length > 0 ? 'fail' : 'ok'} />}
          <span>{summary}</span>
        </Button>
        <Popover variant="panel" placement="bottom end" className="task-popover">
          <Dialog className="task-popover__dialog" aria-label="任务">
            <div className="task-popover__head">
              <span className="task-popover__title">任务</span>
              {finished > 0 ? (
                <Button variant="ghost" size="sm" onPress={() => void window.craft.clearFinishedTasks().then(refresh)}>
                  清除已结束
                </Button>
              ) : null}
            </div>
            <ul className="task-list">
              {[...tasks].reverse().map((task) => {
                const active = task.state === 'running' || task.state === 'queued'
                const progressLabel = taskProgressLabel(task)
                return (
                  <li key={task.id} className="task-row" data-state={task.state}>
                    <div className="task-row__head">
                      <span className="task-row__title" title={task.target ?? undefined}>
                        {task.title}
                      </span>
                      <span className="task-row__state">
                        {TASK_STATE_LABEL[task.state]}
                        {task.endedAt ? ` · ${clockLabel(task.endedAt)}` : task.startedAt ? ` · ${clockLabel(task.startedAt)}` : ''}
                      </span>
                      {active ? (
                        <IconButton aria-label={`取消 ${task.title}`} size="sm" onPress={() => void window.craft.cancelTask(task.id)}>
                          <X size={14} />
                        </IconButton>
                      ) : null}
                    </div>
                    {active ? <ProgressBar aria-label={task.title} value={taskPercent(task) ?? 0} isIndeterminate={taskPercent(task) === null} tone="run" /> : null}
                    {task.error ? <div className="task-row__error">{task.error}</div> : progressLabel ? <div className="task-row__detail">{progressLabel}{task.detail ? ` · ${task.detail}` : ''}</div> : task.detail ? <div className="task-row__detail">{task.detail}</div> : null}
                  </li>
                )
              })}
            </ul>
            <p className="task-popover__foot">已结束的任务最多保留 {KEEP_FINISHED} 条，可随时清除。</p>
          </Dialog>
        </Popover>
      </DialogTrigger>
      <span className="sr-only" aria-live="polite">
        {summary}
      </span>
    </>
  )
}
