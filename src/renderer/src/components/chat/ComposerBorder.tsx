import { useStore } from '../../state/store'
import { useRunProgress } from './run-status'

/**
 * 输入框顶边：运行时只留一条无文字的状态钩子（`data-state` / `data-phase`），
 * 供样式与诊断读取。阶段文字与计时在回合活动行和发送位的「停止 + 计时」上
 * （设计规范「界面重构」：只保留一个主要运行信号）。
 */
export function ComposerBorder() {
  const progress = useRunProgress()
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  return (
    <div
      className="cborder"
      data-level={level}
      data-state={progress ? 'working' : 'idle'}
      data-phase={progress?.phase ?? 'idle'}
      data-testid="composer-border"
      aria-hidden
    />
  )
}

/** 空闲态的顶边（不读运行状态）：分屏非焦点块的输入框外观用它，与真输入框同高 */
export function ComposerBorderIdle() {
  return <div className="cborder" data-state="idle" data-phase="idle" aria-hidden />
}
