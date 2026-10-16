/**
 * 思考行：默认折叠的一行「推理 · 12s ›」，展开为有界的小字窗口。
 *
 * 展示规则对齐 v2 `chat/Reasoning.tsx`，但不引入 v2 控件与 v2 CSS：
 *   · 展开窗口最高 25vh，长推理在窗口内部滚动，不把最终回复推远；
 *   · 只有用户停在窗口底部时才跟随新内容，向上阅读后不再拉回；
 *   · 实时推理开始时自动展开、结束后自动收起；用户动过开合就不再自动动；
 *   · 收起时不挂全文（长推理的隐藏块会拖累分屏切换与合成）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { Icon } from './Icon'

/** 收起态预览：取最后一个非空行，长句保留结尾。 */
function peekText(text: string): string {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.length > 160 ? line.slice(-160) : line
  }
  return ''
}

export function ThinkingLine({ text, ms, live, defaultOpen = false }: { text: string; ms?: number; live?: boolean; defaultOpen?: boolean }): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen || !!live)
  const touchedRef = useRef(false)
  const followRef = useRef(true)
  const wasLiveRef = useRef(!!live)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!touchedRef.current) {
      if (live && !wasLiveRef.current) setOpen(true)
      if (!live && wasLiveRef.current) setOpen(false)
    }
    wasLiveRef.current = !!live
  }, [live])

  /* 展开时只在用户仍贴底阅读的情况下跟随流式更新 */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && open && followRef.current) el.scrollTop = el.scrollHeight
  }, [text, open])

  const secs = ms && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null
  if (!text) return null

  const toggle = (): void => {
    touchedRef.current = true
    followRef.current = true
    const next = !open
    setOpen(next)
    /* 展开后把自己滚进可视区，避免窗口落到输入框后面；已可见则不动 */
    if (next) requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  const label = live ? t('reason.now') : secs ? t('proc.reason', { n: secs }) : t('reason.past')
  const peek = open ? '' : peekText(text)

  return (
    <div ref={rootRef} className="v3-think" data-live={live || undefined} data-open={open || undefined} data-testid="v3-thinking">
      <button className="v3-think-head" aria-expanded={open} onClick={toggle} data-testid="v3-thinking-toggle">
        <Icon name="brain" size={13} className={live ? 'v3-pulse' : undefined} />
        <span className="v3-think-label">{label}</span>
        {peek ? (
          <span className="v3-think-peek" dir="rtl" data-testid="v3-thinking-peek">
            <span dir="ltr">{peek}</span>
          </span>
        ) : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="v3-chev" />
      </button>
      {open ? (
        <div
          ref={bodyRef}
          className="v3-think-body"
          tabIndex={0}
          data-testid="v3-thinking-body"
          onScroll={(event) => {
            const el = event.currentTarget
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}
