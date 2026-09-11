import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 模型选择器 —— 点击后展开成**垂直列表**（不弹居中的模态框）。
 *
 * 为什么是垂直列表而不是网格/横向滚动：
 *   模型名长度差异很大（"DeepSeek V4.1 Flash" vs "Kimi-K2.7-Code"），
 *   横向排列要么截断要么对不齐；垂直列表一行一个，配 provider 分组，
 *   扫读最快。这也是 Agents-Anywhere 与多数编辑器的做法。
 *
 * 展开的浮层是**贴着触发器**往上弹的（不是屏幕居中）——
 * 它在输入区附近，居中弹窗会把视线拉到别处。
 */
export function ModelPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const models = useStore((s) => s.models)
  const setModel = useStore((s) => s.setModel)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

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

  /** 按 provider 分组 + 按搜索词过滤 */
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

  const cur = session?.model
  const busy = !!session?.isStreaming || !!session?.isCompacting

  if (!cur) return null

  /** 展开时把当前项滚进视野 —— 列表很长，不滚的话看不到自己在哪 */
  const listRef = (el: HTMLDivElement | null): void => {
    if (!el || !open) return
    const sel = el.querySelector<HTMLElement>('[data-current="1"]')
    sel?.scrollIntoView({ block: 'center' })
  }

  return (
    <div className="picker-wrap" ref={box}>
      <button
        className={`ub-pick ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={busy ? t('picker.busy') : t('picker.modelTip')}
        data-testid="model-picker"
      >
        <span className="ub-pick-text">{cur.name}</span>
        <Icon name="chevron-right" size={12} className={`chev ${open ? 'up' : ''}`} />
      </button>

      {open ? (
        <div className="mpop" data-testid="model-menu">
          {/* 搜索：69 个模型必须有过滤 */}
          <div className="mpop-search">
            <Icon name="search" size={12} />
            <input
              autoFocus
              value={query}
              placeholder={t('picker.searchModel')}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="mpop-count">{models.length}</span>
          </div>

          {/* 垂直列表 */}
          <div className="mpop-list" ref={listRef}>
            {groups.length === 0 ? (
              <div className="mpop-empty">{t('picker.noMatch')}</div>
            ) : (
              groups.map(([provider, list]) => (
                <div key={provider} className="mpop-group">
                  <div className="mpop-group-head">{provider}</div>
                  {list.map((m) => {
                    const on = m.provider === cur.provider && m.id === cur.id
                    return (
                      <button
                        key={`${m.provider}|${m.id}`}
                        className={`mpop-item ${on ? 'sel' : ''}`}
                        title={m.id}
                        data-current={on ? '1' : '0'}
                        onClick={() => {
                          void setModel(m.provider, m.id)
                          setOpen(false)
                        }}
                      >
                        <span className="mpop-item-name">{m.name}</span>
                        {m.reasoning ? <span className="mpop-tag">{t('picker.reasoning')}</span> : null}
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

/**
 * 思考强度 —— **横向滑动切换**（分段控件，不弹菜单）。
 *
 * 为什么不做下拉：档位少（3~7 个）、切换频繁，横向一排直接点比
 * 「点开 → 找 → 点」少两步。左右方向键也能切换。
 *
 * 档位由 pi 给（get_available_thinking_levels）——
 * 不同模型支持的档不一样，所以不能用固定列表。
 */
export function ThinkingPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const levels = useStore((s) => s.thinkingLevels)
  const setThinking = useStore((s) => s.setThinking)

  const cur = session?.thinkingLevel ?? 'off'
  const busy = !!session?.isStreaming || !!session?.isCompacting

  const segRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** 滑块位置：从选中项**实测**得到，而不是按档位数等分计算 */
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

  /**
   * 为什么必须实测：
   *   档位文字宽度不等（"不思考" 3 字、"少" 1 字），
   *   按 (100% / N) 等分算出来的滑块会跟真实按钮错位
   *   （实测差 14px，看着像"选中的是旁边那档"）。
   *   所以用 offsetLeft/offsetWidth 读真实位置。
   */
  const measure = (): void => {
    const idx = levels.indexOf(cur)
    const el = btnRefs.current[idx]
    if (!el) return
    setThumb({ left: el.offsetLeft, width: el.offsetWidth })
  }

  // 档位 / 选中项 / 字体加载完成时都重量一次
  useEffect(() => {
    measure()
    // 字体异步加载完宽度会变，重测一次
    void document.fonts?.ready.then(() => measure())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, levels.join(','), busy])

  // 面板宽度变化也要重测（侧栏展开会挤压主区）
  useEffect(() => {
    const el = segRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels.join(',')])

  // 只支持一档（off）时没有切换的必要
  if (levels.length <= 1) return null

  /** 档位中文说明 —— 光看 "medium" 不知道意味着什么 */
  const label = (l: string): string => {
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

  const idx = Math.max(0, levels.indexOf(cur))

  /** 左右方向键切换（键盘可达） */
  const onKey = (e: React.KeyboardEvent): void => {
    if (busy) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = e.key === 'ArrowLeft' ? idx - 1 : idx + 1
    if (next < 0 || next >= levels.length) return
    void setThinking(levels[next])
  }

  return (
    <div
      className={`think-seg ${busy ? 'busy' : ''}`}
      role="radiogroup"
      aria-label={t('picker.thinkTip')}
      title={busy ? t('picker.busy') : t('picker.thinkTip')}
      data-testid="thinking-picker"
      ref={segRef}
      tabIndex={0}
      onKeyDown={onKey}
    >
      {thumb ? (
        <span
          className="think-thumb"
          style={{ left: thumb.left, width: thumb.width }}
          aria-hidden
        />
      ) : null}
      {levels.map((l, i) => (
        <button
          key={l}
          ref={(el) => {
            btnRefs.current[i] = el
          }}
          className={`think-opt ${l === cur ? 'on' : ''}`}
          role="radio"
          aria-checked={l === cur}
          disabled={busy}
          onClick={() => void setThinking(l)}
          data-testid={`thinking-${l}`}
          title={l}
        >
          {label(l)}
        </button>
      ))}
    </div>
  )
}
