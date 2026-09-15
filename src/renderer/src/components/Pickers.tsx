import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 模型 + 思考强度选择器 —— 终端风格。
 *
 * 收起态（输入框右下）：
 *   `DeepSeek V4.1 Flash` + `高`（强调色）+ chevron
 *
 * 展开态（贴着触发器向上弹）：
 *   上半  当前模型名 + 一排**档位**（关 / 轻度 / 中 / 高 / 极高 / Ultra / Max）
 *   下半  模型列表（搜索 + 按 provider 分组）
 *
 * ⚠️ 为什么把原生 range 滑块换成了档位：
 *   之前的实现用 `input[type=range]` + `::-webkit-slider-runnable-track/thumb`，
 *   在 Chromium 里实际渲染出的是「一条 14px 高的粗蓝条 + 一个 16px 的方块」——
 *   轨道比滑块矮、滑块又比轨道高，视觉上是断的；再叠一层绝对定位的
 *   `mt-scale` 小方块行，两套「档位」指示互相打架。用户看到的就是「有 bug」。
 *
 *   而且滑块本身是个**谎言**：档位是离散的 5~7 档，滑动却没有中间态可用。
 *   档位按钮是 1:1 的映射 —— 看到几个方块就是几档，点哪个就是哪个。
 */
export function ModelThinkingPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const models = useStore((s) => s.models)
  const levels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  /* 回复详细程度（方案 3.1）：与推理强度分开的两个维度 */
  const patchSettings = useStore((s) => s.patchSettings)
  const responseDetail = useStore((s) => s.settings?.responseDetail ?? 'standard')

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * 菜单最大高度（px）—— 按**触发器上方的真实可用空间**算（N08）。
   *
   * 为什么不只用 CSS：菜单是向上弹的（`bottom: 100%`），固定 `max-height`
   * 在矮窗口里会把面板顶出窗口上沿（用户报的「看不到全部模型」）。
   * 打开时量一次 `top` 再算，窗口多矮都不会越界；普通 900px 高窗口
   * 给到 560px，列表能一次看到 8 行以上。
   */
  const [maxH, setMaxH] = useState(0)
  /** 键盘高亮的下标（对应扁平后的模型列表）；-1 = 没在用键盘 */
  const [cursor, setCursor] = useState(-1)
  const box = useRef<HTMLDivElement>(null)

  const cur = session?.model
  const level = session?.thinkingLevel ?? 'off'
  const thinkingStatus = session?.thinkingLevelsStatus ?? (levels.length ? 'known' : 'unknown')
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

  /*
   * 打开时量上方的可用高度（含窗口缩放后的 CSS 像素）。
   * 用 useLayoutEffect：要在浏览器绘制前定下 max-height，
   * 否则会先渲染一帧越界高度再跳一下。
   */
  useLayoutEffect(() => {
    if (!open) {
      setMaxH(0)
      return
    }
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      /* 上方留 20px 安全边距（菜单本身还要往上 6px 的间隔），封顶 560px */
      setMaxH(Math.max(200, Math.min(560, Math.floor(r.top - 26))))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  /**
   * 档位的中文名。
   *
   * 与 pi 的 7 档一一对应（off → max），不合并：
   * 合并会让「点了没变化」变成可能的体验（两个档位映射到同一个名字）。
   */
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

  /*
   * ⚠️ 这里曾经是 `if (!cur) return null`（用户报的「看不到模型选择」）。
   *
   * pi 未就绪、启动超时或凭证失效时 `session` 为 null，于是选择器**整个消失**：
   * 用户既看不到当前模型，也失去了唯一的换模型入口 —— 而这恰恰是最需要
   * 一个入口去排查/救援的时刻。现在改为降级渲染：触发器显示「模型未就绪」，
   * 菜单仍可打开（列表为空时给明确空态）。
   *
   * 注意 `session.model` 在无凭证时是 `{id:'unknown', provider:'unknown'}`，
   * **并不为空**；真正为空的只有 `session` 本身。
   */
  const hasLevels = levels.length > 1
  const showThinkingSection = hasLevels || thinkingStatus !== 'known'

  /** 分组扁平化 —— 键盘上下走的是这个顺序（与视觉顺序一致） */
  const flat = groups.flatMap(([, list]) => list)
  const indexOf = new Map(flat.map((m, i) => [`${m.provider}|${m.id}`, i]))

  /** 展开时把当前模型滚进视野 */
  const listRef = (el: HTMLDivElement | null): void => {
    if (!el || !open) return
    el.querySelector<HTMLElement>('[data-current="1"]')?.scrollIntoView({ block: 'center' })
  }

  /**
   * 键盘高亮（N08：鼠标与键盘都能选中）。
   *
   * 打开、搜索结果变化、以及点选某个模型之后都重算一次：
   * 高亮始终落在当前模型上（找不到就第一项），用户一进来就能直接上下走。
   */
  const cursorKey = cursor >= 0 ? `${flat[cursor]?.provider}|${flat[cursor]?.id}` : ''
  useEffect(() => {
    if (!open) return
    const i = flat.findIndex((m) => m.provider === cur?.provider && m.id === cur?.id)
    setCursor(i >= 0 ? i : flat.length > 0 ? 0 : -1)
    // 依赖只取「列表变了没 / 当前模型变了没」，平铺数组每次新建不能用引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flat.length, query, cur?.provider, cur?.id])

  /** 高亮项滚进视野（键盘走到底时列表要跟着动） */
  const cursorEl = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open) return
    cursorEl.current?.scrollIntoView({ block: 'nearest' })
  }, [open, cursorKey])

  /**
   * 搜索框的键盘导航。
   *
   * Enter 只「接受当前高亮」，不发消息、也不关面板 —— 用户可能接着调
   * 思考强度而模型已经切好了。⌘/IME 组合期间完全不打岔，选词用得上的
   * Enter / 方向键必须留给输入法。
   */
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length === 0) return
      const base = cursor < 0 ? -1 : cursor
      const next = e.key === 'ArrowDown' ? base + 1 : base - 1
      setCursor(Math.max(0, Math.min(flat.length - 1, next)))
      return
    }
    if (e.key === 'Enter') {
      const m = cursor >= 0 ? flat[cursor] : undefined
      if (!m) return
      e.preventDefault()
      void setModel(m.provider, m.id)
    }
  }

  return (
    <div className="picker-wrap" ref={box}>
      <button
        className={`mt-trigger ${open ? 'open' : ''} ${cur ? '' : 'unknown'}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={busy ? t('picker.busy') : cur ? t('picker.modelTip') : t('picker.notReadyTip')}
        data-testid="model-picker"
        data-state={cur ? 'ready' : 'unknown'}
      >
        <span className="mt-model">{cur ? cur.name : t('picker.notReady')}</span>
        {hasLevels && level !== 'off' ? (
          <span className="mt-level" data-testid="thinking-badge">
            {thinkLabel(level)}
          </span>
        ) : null}
        <span className="mt-chev">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="mt-pop" data-testid="model-menu" style={maxH ? { maxHeight: maxH } : undefined}>
          {/* ---- 上半：档位 ---- */}
          {showThinkingSection ? (
            <div className="mt-head">
              <div className="mt-head-row">
                <span className="mt-head-title" title={t('picker.thinkDesc')}>{t('picker.think')}</span>
                <span className="spacer" />
                <span className="mt-head-level" data-testid="thinking-current">
                  {hasLevels
                    ? thinkLabel(level)
                    : thinkingStatus === 'unsupported'
                      ? t('picker.thinkUnsupported')
                      : t('picker.thinkUnknown')}
                </span>
              </div>

              {/* 档位按钮：一个方块 = 一档。终端风格的等宽分段。
                  `--i` 让它们从左到右依次落位（像终端打印出来）。 */}
              {hasLevels ? (
                <div className="mt-stops" data-testid="thinking-stops">
                  {levels.map((l, i) => (
                    <button
                      key={l}
                      style={{ '--i': i } as React.CSSProperties}
                      className={`mt-stop ${l === level ? 'on' : ''}`}
                      onClick={() => void setThinking(l)}
                      disabled={busy}
                      title={l}
                      data-testid={`thinking-dot-${l}`}
                      data-level={l}
                      data-on={l === level ? '1' : '0'}
                    >
                      {thinkLabel(l)}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-capability-note" data-testid="thinking-capability-status">
                  {thinkingStatus === 'unsupported' ? t('picker.thinkUnsupported') : t('picker.thinkUnknown')}
                </div>
              )}

              {/* 说明只在空间充裕时占位：矮窗口把高度让给模型列表（N08） */}
              {maxH > 520 ? <div className="mt-hint">{t('picker.thinkDesc')}</div> : null}
            </div>
          ) : null}

          {/*
           * ---- 回复详细程度（方案 3.1）----
           * 与推理强度是**两件事**：一个管「想多深」，一个管「讲多细」。
           * 放在同一个菜单里，因为它们是同一个决定（要多少篇幅）。
           */}
          <div className="mt-head">
            <div className="mt-head-row">
              <span className="mt-head-title" title={t('picker.detailDesc')}>{t('picker.detail')}</span>
              <span className="spacer" />
              <span className="mt-head-level" data-testid="detail-current">
                {detailLabel(responseDetail, t)}
              </span>
            </div>
            <div className="mt-stops" data-testid="detail-stops">
              {(['brief', 'standard', 'detailed'] as const).map((d, i) => (
                <button
                  key={d}
                  style={{ '--i': i } as React.CSSProperties}
                  className={`mt-stop ${d === responseDetail ? 'on' : ''}`}
                  onClick={() => void patchSettings({ responseDetail: d })}
                  disabled={busy}
                  data-testid={`detail-${d}`}
                  data-on={d === responseDetail ? '1' : '0'}
                >
                  {detailLabel(d, t)}
                </button>
              ))}
            </div>
            {maxH > 520 ? <div className="mt-hint">{t('picker.detailDesc')}</div> : null}
          </div>
          {/* ---- 下半：模型列表 ---- */}
          <div className="mt-search">
            <Icon name="search" size={12} />
            <input
              autoFocus
              value={query}
              placeholder={t('picker.searchModel')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              data-testid="model-search"
            />
            <span className="mt-count">{models.length}</span>
          </div>

          <div className="mt-list" ref={listRef}>
            {groups.length === 0 ? (
              <div className="mt-empty">
                {models.length === 0 ? t('picker.noModels') : t('picker.noMatch')}
              </div>
            ) : (
              (() => {
                /*
                 * 列表项的错开序号。
                 *
                 * 只错开前 12 个：69 个模型全错开的话，最后一个要等
                 * 69×8ms ≈ 550ms 才出现，那就不像「入场」而像「卡了」。
                 */
                let seq = 0
                return groups.map(([provider, list]) => (
                  <div key={provider} className="mt-group">
                    <div className="mt-group-head">{provider}</div>
                    {list.map((m) => {
                      const on = !!cur && m.provider === cur.provider && m.id === cur.id
                      const idx = indexOf.get(`${m.provider}|${m.id}`) ?? -1
                      const isCursor = idx === cursor
                      const i = Math.min(seq++, 12)
                      return (
                        <button
                          key={`${m.provider}|${m.id}`}
                          ref={isCursor ? cursorEl : undefined}
                          style={{ '--i': i } as React.CSSProperties}
                          className={`mt-item ${on ? 'sel' : ''} ${isCursor ? 'cur' : ''}`}
                          title={m.id}
                          data-current={on ? '1' : '0'}
                          data-cursor={isCursor ? '1' : '0'}
                          onClick={() => {
                            void setModel(m.provider, m.id)
                            // 不关面板 —— 用户可能接着调强度
                          }}
                        >
                          <span className="mt-item-name">{m.name}</span>
                          {m.reasoning ? <span className="mt-tag">{t('picker.reasoning')}</span> : null}
                          {m.input?.includes('image') ? <span className="mt-tag">{t('picker.image')}</span> : null}
                          {on ? <Icon name="check" size={12} /> : null}
                        </button>
                      )
                    })}
                  </div>
                ))
              })()
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 回复详细程度的中文名（方案 3.1）。
 *
 * 三档都说清「它对输出做了什么」，不用「简短 / 正常 / 啰嗦」这类
 * 带评价的词 —— 用户选的是篇幅，不是质量。
 */
function detailLabel(v: string, t: (k: 'detail.brief' | 'detail.standard' | 'detail.detailed') => string): string {
  if (v === 'brief') return t('detail.brief')
  if (v === 'detailed') return t('detail.detailed')
  return t('detail.standard')
}
