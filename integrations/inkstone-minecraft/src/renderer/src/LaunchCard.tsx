import { useEffect, useState, type ReactElement } from 'react'
import { CircleCheck, CircleSlash, FileText, LoaderCircle, Square, X } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { ProgressBar } from '@yan/ui/Progress'
import type { LaunchStatus } from '../../shared/api.ts'
import type { LaunchEffective, LaunchStep, SettingSource } from '../../shared/launch-api.ts'

const SETTING_SOURCE_LABEL: Record<SettingSource, string> = { instance: '单版本设置', pcl: 'PCL 设置', global: '全局' }

function memoryLabel(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`
}

interface Props {
  status: LaunchStatus
  steps: LaunchStep[]
  effective?: LaunchEffective | null
  runningSince: number | null
  onCancel(): void
  onStop(): void
  onLogs(): void
}

function elapsedLabel(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} 小时${rest > 0 ? ` ${rest} 分钟` : ''}`
}

function glyph(state: LaunchStep['state']): ReactElement {
  if (state === 'done') return <CircleCheck size={14} />
  if (state === 'running') return <LoaderCircle size={14} className="launch-step__spin" />
  if (state === 'failed') return <CircleSlash size={14} />
  return <span className="launch-step__dot" aria-hidden="true" />
}

export function LaunchCard({ status, steps, effective, runningSince, onCancel, onStop, onLogs }: Props): ReactElement {
  const [now, setNow] = useState(() => Date.now())
  const starting = status.state === 'starting'
  const current = steps.find((step) => step.state === 'running') ?? steps.find((step) => step.state === 'pending') ?? null
  const done = steps.filter((step) => step.state === 'done').length

  useEffect(() => {
    if (starting) return
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [starting])

  return (
    <div className="launch-card" data-state={status.state} aria-busy={starting}>
      <div className="launch-card__head">
        <span className="launch-card__title">{starting ? '正在启动' : '运行中'}</span>
        <span className="launch-card__meta">
          {starting ? `${done}/${steps.length} 步` : runningSince ? `已运行 ${elapsedLabel(runningSince, now)}` : null}
        </span>
      </div>
      <ProgressBar
        aria-label="启动进度"
        className="launch-card__bar"
        value={done}
        maxValue={steps.length}
        isIndeterminate={starting && current === null}
        tone="run"
      />
      <ol className="launch-steps">
        {steps.map((step) => (
          <li key={step.id} className="launch-step" data-state={step.state}>
            <span className="launch-step__glyph" aria-hidden="true">
              {glyph(step.state)}
            </span>
            <span className="launch-step__label">{step.label}</span>
            {step.detail ? <span className="launch-step__detail">{step.detail}</span> : null}
            {step.progress ? (
              <ProgressBar
                aria-label={`${step.label} 进度`}
                className="launch-step__progress"
                value={step.progress.done}
                maxValue={Math.max(step.progress.total, 1)}
                isIndeterminate={step.progress.total <= 0}
                tone="run"
              />
            ) : null}
          </li>
        ))}
      </ol>
      {effective ? (
        <div className="launch-card__effective" aria-label="生效的启动设置">
          <span title={effective.javaPath ?? undefined}>Java {effective.javaMajor ?? '?'}（{SETTING_SOURCE_LABEL[effective.javaSource]}）</span>
          <span>内存 {memoryLabel(effective.maxMemoryMb)}（{SETTING_SOURCE_LABEL[effective.memorySource]}）</span>
          {effective.jvmArgs ? <span title={effective.jvmArgs}>JVM 参数（{SETTING_SOURCE_LABEL[effective.jvmSource]}）</span> : null}
          {effective.gameArgs ? <span title={effective.gameArgs}>游戏参数（{SETTING_SOURCE_LABEL[effective.gameArgsSource]}）</span> : null}
          {effective.width || effective.height || effective.fullscreen ? (
            <span>
              窗口 {effective.fullscreen ? '全屏' : `${effective.width ?? '?'}×${effective.height ?? '?'}`}（{SETTING_SOURCE_LABEL[effective.windowSource]}）
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="launch-card__foot">
        {starting ? (
          <Button variant="ghost" size="sm" icon={<X size={14} />} onPress={onCancel}>
            取消
          </Button>
        ) : (
          <Button variant="danger" size="sm" icon={<Square size={12} />} onPress={onStop}>
            停止
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={<FileText size={14} />} onPress={onLogs}>
          日志
        </Button>
      </div>
    </div>
  )
}
