/**
 * 对话大纲轨（v3 WP-21b，方案 02 §8.9）。
 *
 * 对话区左缘常驻，每轮用户消息一个刻度，
 * 点击把对话定位到那一轮。回合数据复用 `shared/outline-turns` 的正式投影，
 * 与 `SessionView` 的滚动跳转是同一套分组口径，刻度下标不会错位。
 *
 * 容器不接收指针，轨道自身接收点击；轨道位于触发窄带之上，避免窄带吃掉点击。
 * 键盘 Tab 可以逐轮聚焦，悬停与聚焦只增强显示。组件本身不含状态。
 *
 * 只负责「列出 + 报告点了第几轮」；真正的滚动由 `SessionView` 完成 —— 只有
 * 这样才能在建视图的同时把「跟随底部」关掉，不把阅读位置强拉到底部。
 */
import { useMemo, type CSSProperties, type JSX } from 'react'
import { useT } from '../../i18n'
import type { UIMessage } from '../../../../shared/ipc'
import { createOutlineProjector } from '../../../../shared/outline-turns'
import './rail.css'

/**
 * 把一个「用户回合下标」换算成回合投影数组里的下标。
 *
 * 导航轨列的是用户回合，而 `SessionView` 的回合数组里用户块与助手块交替出现，
 * 虚拟列表定位要用后者。这里只做纯换算，便于单测。
 * 越界返回 undefined，不猜、不落到最后一轮。
 */
export function userTurnRenderIndex(turns: readonly { kind: string }[], userIndex: number): number | undefined {
  const userTurns: number[] = []
  turns.forEach((turn, index) => {
    if (turn.kind === 'user') userTurns.push(index)
  })
  return userTurns[userIndex]
}

export interface OutlineRailProps {
  /** 与对话流相同的正式消息（含已合并的提问记录）。 */
  messages: UIMessage[]
  /** 正在流式的助手消息 id，交给投影区分「已完成 / 生成中」。 */
  streamingId?: string
  /** 点击某一轮；下标是「用户回合」的序号（0 起）。 */
  onJump: (index: number) => void
  className?: string
}

export function OutlineRail({ messages, streamingId, onJump, className }: OutlineRailProps): JSX.Element | null {
  const t = useT()
  /* 与 v2 相同的独立投影缓存：已完成的回合不随当前流式文字重建。 */
  const projectOutline = useMemo(() => createOutlineProjector(), [])
  const turns = useMemo(() => projectOutline(messages, streamingId), [messages, streamingId, projectOutline])

  /* 有一轮即可导航；空会话不展示轨道。 */
  if (turns.length === 0) return null

  return (
    <div className={`v3-rail ${className ?? ''}`.trim()} data-testid="v3-outline-rail">
      {/* 右缘窄带：指针进入即展开；本身不可聚焦、不进无障碍树。 */}
      <div className="v3-rail-zone" data-testid="v3-outline-zone" aria-hidden />
      <div className="v3-rail-track" role="navigation" aria-label={t('outline.label')}>
        {turns.map((turn, index) => (
          <button
            key={turn.msgId}
            type="button"
            className="v3-rail-tick"
            data-testid="v3-outline-tick"
            title={turn.user}
            aria-label={t('outline.tick', { n: index + 1 })}
            style={{ '--i': Math.min(index, 14) } as CSSProperties}
            onClick={() => onJump(index)}
          >
            <span className="v3-rail-bar" />
          </button>
        ))}
      </div>
    </div>
  )
}
