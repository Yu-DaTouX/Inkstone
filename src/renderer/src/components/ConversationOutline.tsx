import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 对话导航轨 —— 消息流左侧那一条刻度。
 *
 * 每一格对应一轮**用户发起的对话**，作用有三个：
 *   · 一眼看出这个会话有多长（不用滚到底）
 *   · 看得出当前读到哪（高亮那一格）
 *   · 悬停预览 + 点击跳转（长会话里不用一路滚）
 *
 * 位置用**滚动进度**估算，而不是去测每个消息元素的位置 ——
 * 因为长会话走虚拟化，没渲染的消息根本没有 DOM 节点，测不到。
 * 刻度盘本来也只需要「大概在哪」，精确位置得不偿失。
 *
 * 位置用 flex 均分而不是按像素排：消息高度差异极大（一句话 vs 一段代码），
 * 按高度排会让刻度全挤在一起。
 */
export function ConversationOutline() {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const scrollProgress = useStore((s) => s.scrollProgress)
  const scrollToTurn = useStore((s) => s.scrollToTurn)
  const [hover, setHover] = useState<number | null>(null)

  /** 每一轮：用户消息 + 紧接着的助手回复（用来做预览摘要） */
  const turns = useMemo(() => {
    const out: { user: string; assistant: string; msgId: string; index: number }[] = []
    messages.forEach((m, i) => {
      if (m.role !== 'user') return
      const next = messages[i + 1]
      out.push({
        user: m.text,
        assistant: next?.role === 'assistant' ? next.text : '',
        msgId: m.id,
        index: i
      })
    })
    return out
  }, [messages])

  // 轮数太少时不显示（2-3 格既没用又占地方）
  if (turns.length < 3) return null

  // 当前读到第几轮：用滚动进度估算
  const active = Math.min(turns.length - 1, Math.max(0, Math.round(scrollProgress * (turns.length - 1))))

  return (
    <div className="outline" data-testid="outline" role="navigation" aria-label={t('outline.label')}>
      <div className="outline-track">
        {turns.map((turn, i) => (
          <button
            key={turn.msgId}
            className={`outline-tick ${i === active ? 'on' : ''} ${i === hover ? 'hover' : ''}`}
            /* 用 mouseover/mouseout 而不是 mouseenter/mouseleave：
               React 的 enter/leave 是从 mouseover/mouseout 合成的，
               直接派发 enter 不触发；over/out 是原生冒泡事件，行为可预测。
               （刻度没有子元素，不用担心冒泡重复触发） */
            onMouseOver={() => setHover(i)}
            onMouseOut={() => setHover((h) => (h === i ? null : h))}
            onClick={() => scrollToTurn(i)}
            data-testid="outline-tick"
            aria-label={t('outline.tick', { n: i + 1 })}
          />
        ))}
      </div>

      {hover !== null ? <OutlinePreview turn={turns[hover]} n={hover + 1} total={turns.length} /> : null}
    </div>
  )
}

/** 悬停预览：这一轮问了什么、答了什么开头 */
function OutlinePreview({
  turn,
  n,
  total
}: {
  turn: { user: string; assistant: string }
  n: number
  total: number
}) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)

  // 预览卡可能超出视口高度，挂载后量一下并夹住位置
  useEffect(() => {
    const el = card.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.top < 8) el.style.marginTop = `${8 - r.top}px`
    else if (r.bottom > window.innerHeight - 8) {
      el.style.marginTop = `${window.innerHeight - 8 - r.bottom}px`
    }
  }, [])

  return (
    <div className="outline-preview" ref={card} data-testid="outline-preview">
      <div className="op-head">
        <span className="op-n">
          {n} / {total}
        </span>
        <span className="op-hint">{t('outline.click')}</span>
      </div>
      <div className="op-user">{clean(turn.user)}</div>
      {turn.assistant ? <div className="op-assistant">{clean(turn.assistant)}</div> : null}
    </div>
  )
}

/** 预览里不需要 markdown 语法噪音，压成纯文本并截断 */
function clean(s: string): string {
  const plain = s
    .replace(/```[\s\S]*?```/g, ' […] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>|-]{1,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain
}
