import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 模型 + 思考强度选择器 —— Codex 风格。
 *
 * 收起态（输入框底部）：
 *   `DeepSeek V4.1 Flash` + `中`（强调色）+ chevron
 *   —— 两部分合成一个标签：模型回答「用什么」，强度回答「思考多久」。
 *
 * 展开态（贴着触发器向上弹）：
 *   上半  当前强度名（大、强调色）+ 模型名（灰），一条**滑块**调强度
 *   下半  模型列表（搜索 + 按 provider 分组）
 *
 * 为什么强度用滑块而不是一排按钮：
 *   Codex 是这么做的，而且强度本质是**连续量**（off→max），
 *   滑块比一堆按钮更贴合「调档」的心智，也更省横向空间。
 *   滑块用原生 input[type=range]（无障碍与键盘天然可用），只做视觉定制。
 */
export function ModelThinkingPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const models = useStore((s) => s.models)
  const levels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  const cur = session?.model
  const level = session?.thinkingLevel ?? 'off'
  const busy = !!session?.isStreaming || !!session?.isCompacting

  // 点外面 / Esc 关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  /** 强度档位的中文名 —— 光看 medium 不知道意味着什么 */
  const thinkLabel = (l: string): string => {
    const map: Record<string, string> = {
      off: t('think.off'),
      minimal: t('think.minimal'),
      low: t('think.low'),
      medium: t('think.medium'),
      high: t('think.high'),
      xhigh: t('think.xhigh'),
      max: t('think.max')
    }
    return map[l] ?? l
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = q
      ? models.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q)
        )
      : models
    const byProvider = new Map<string, typeof models>()
    for (const m of hit) {
      const list = byProvider.get(m.provider) ?? []
      list.push(m)
      byProvider.set(m.provider, list)
    }
    return [...byProvider.entries()]
  }, [models, query])

  if (!cur) return null

  const idx = Math.max(0, levels.indexOf(level))
  const hasLevels = levels.length > 1

  /** 展开时把当前模型滚进视野 */
  const listRef = (el: HTMLDivElement | null): void => {
    if (!el || !open) return
    el.querySelector<HTMLElement>('[data-current="1"]')?.scrollIntoView({ block: 'center' })
  }

  return (
    <div className="picker-wrap" ref={box}>
      <button
        className={`mt-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={busy ? t('picker.busy') : t('picker.modelTip')}
        data-testid="model-picker"
      >
        <span className="mt-model">{cur.name}</span>
        {hasLevels && level !== 'off' ? (
          <span className="mt-level">{thinkLabel(level)}</span>
        ) : null}
        <Icon name="chevron-right" size={12} className={`chev ${open ? 'up' : ''}`} />
      </button>

      {open ? (
        <div className="mt-pop" data-testid="model-menu">
          {/* ---- 上半：强度滑块 ---- */}
          <div className="mt-head">
            <div className="mt-head-row">
              {hasLevels ? (
                <span className="mt-head-level" data-testid="thinking-current">
                  {thinkLabel(level)}
                </span>
              ) : null}
              <span className="mt-head-model">{cur.name}</span>
            </div>

            {hasLevels ? (
              <>
                {/* 原生 range：键盘可达、无障碍天然可用，只做视觉定制 */}
                <input
                  className="mt-slider"
                  type="range"
                  min={0}
                  max={levels.length - 1}
                  step={1}
                  value={idx}
                  disabled={busy}
                  onChange={(e) => void setThinking(levels[Number(e.target.value)])}
                  aria-label={t('picker.thinkTip')}
                  data-testid="thinking-slider"
                  style={{ '--fill': `${(idx / (levels.length - 1)) * 100}%` } as React.CSSProperties}
                />
                <div className="mt-scale">
                  {levels.map((l, i) => (
                    <button
                      key={l}
                      className={`mt-scale-dot ${i === idx ? 'on' : ''}`}
                      onClick={() => void setThinking(l)}
                      disabled={busy}
                      title={l}
                      data-testid={`thinking-dot-${l}`}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {/* ---- 下半：模型列表 ---- */}
          <div className="mt-search">
            <Icon name="search" size={12} />
            <input
              autoFocus={!hasLevels}
              value={query}
              placeholder={t('picker.searchModel')}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="mt-count">{models.length}</span>
          </div>

          <div className="mt-list" ref={listRef}>
            {groups.length === 0 ? (
              <div className="mt-empty">{t('picker.noMatch')}</div>
            ) : (
              groups.map(([provider, list]) => (
                <div key={provider} className="mt-group">
                  <div className="mt-group-head">{provider}</div>
                  {list.map((m) => {
                    const on = m.provider === cur.provider && m.id === cur.id
                    return (
                      <button
                        key={`${m.provider}|${m.id}`}
                        className={`mt-item ${on ? 'sel' : ''}`}
                        title={m.id}
                        data-current={on ? '1' : '0'}
                        onClick={() => {
                          void setModel(m.provider, m.id)
                          // 不关面板 —— 用户可能接着调强度
                        }}
                      >
                        <span className="mt-item-name">{m.name}</span>
                        {m.reasoning ? <span className="mt-tag">{t('picker.reasoning')}</span> : null}
                        {on ? <Icon name="check" size={12} /> : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
