/**
 * 推理胶囊（用户要求）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户原话
 * ══════════════════════════════════════════════════════════════════
 *   「在这里开一个胶囊 用逐字流式输出的方式展示模型的推理过程
 *     （如果没有推理过程就不显示）」
 *   「当推理结束 折叠推理内容胶囊并且保留打开开关」
 *
 * ── 三个决定 ──
 * ① **逐字**：模型给的是**块**（一次几十上百字），直接贴上去是「一大段突然出现」。
 *    这里用 `useTypewriter` 把它按字吐出来 —— 追不上时按积压量加速，
 *    所以既像逐字输出，又不会越落越远（详见 hook 的注释）。
 * ② **回合结束前不折叠**：正在推理时胶囊是展开的（用户就是要「看着它在想」），
 *    但折叠的时机是**整个助手回合结束**（`turnLive`）——不是单段推理结束。
 *    结束后自动折叠成一行，**保留开关**。
 * ③ **没有推理就不显示**：`text` 为空直接返回 null —— 不占位、不留空壳。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-09 改版（方案 4.4）：固定窗口 + 可拖尺寸 + 柔和尾部
 * ══════════════════════════════════════════════════════════════════
 *   · 默认显示约 **3 行**（固定高度，超出内部滚动），不再是「随内容自适应」——
 *     自适应会让长推理把回答顶走、短推理又留着一段空白，两种都难用；
 *   · 底部把手可拖，尺寸**按窗口全局记忆**（双击复位）；上限取消息视口的 60%；
 *   · 展开/收起用**保留挂载的容器 + 高度过渡**（160–220ms），
 *     先把最后一段内容显示完再收起，不会因为卸载丢掉尾部；
 *   · 逐字按**字素**推进（中文标点 / emoji / 组合字符不会被切开），
 *     新增的尾部做 140ms 透明度过渡，稳定历史文本不做重复动画；
 *   · 上滚暂停跟随并给「回到最新」，滚回底部自动恢复；
 *   · 遵从 `prefers-reduced-motion`：不做打字与高度动画，直接显示。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'

/** 默认约 3 行（行高 18px + 上下 padding） */
const DEFAULT_REASON_H = 58
const MIN_REASON_H = 34
/** 尺寸记忆键：全局（会话间复用，方案 4.4） */
const SIZE_KEY = 'yan.reasonHeight'

/** 用户调整上限：消息视口的 60% */
function maxReasonHeight(): number {
  return Math.max(DEFAULT_REASON_H + 40, Math.round(window.innerHeight * 0.6))
}

function loadReasonHeight(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY))
    if (Number.isFinite(n) && n >= MIN_REASON_H) return Math.min(maxReasonHeight(), Math.round(n))
  } catch {
    /* 读不到就用默认 */
  }
  return DEFAULT_REASON_H
}

function saveReasonHeight(h: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(Math.round(h)))
  } catch {
    /* 隐私模式等写不了，忽略 */
  }
}

function clearReasonHeight(): void {
  try {
    localStorage.removeItem(SIZE_KEY)
  } catch {
    /* 同上 */
  }
}

/** 系统是否要求减少动态效果 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 字素切分器（模块级单例，别每帧新建） */
const SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null

/** 把字符串切成「用户眼里的字」（中文标点 / emoji / 组合字符不拆开） */
function toUnits(s: string): string[] {
  if (!s) return []
  if (SEGMENTER) return [...SEGMENTER.segment(s)].map((x) => x.segment)
  return Array.from(s)
}

function ReasoningCapsuleImpl({
  text,
  ms,
  live,
  turnLive
}: {
  text: string
  /** 推理耗时（历史消息从会话里读不到，那时是 undefined） */
  ms?: number
  /** 模型**此刻**是否正在吐推理字（控制 spinner、「推理中」标题、光标） */
  live?: boolean
  /**
   * 整个助手回合是否还在进行（含工具执行、后续再思考）。
   * 推理窗口的**展开与折叠时机**跟它走，不跟单段推理走。
   */
  turnLive?: boolean
}) {
  const t = useT()
  /** 用户手动开关；null = 还没手动干预过（此时跟随 turnLive） */
  const [manual, setManual] = useState<boolean | null>(null)
  /** 没有回合级信号时（历史消息）退回到单段信号 */
  const streaming = turnLive ?? live
  /** 逐字显示用的文本（逐步追上 text）；减少动态效果时直接给全文 */
  const reduced = useRef(prefersReducedMotion()).current
  const shown = useTypewriter(text, !!streaming && !reduced)
  const open = manual ?? !!streaming

  /* ---- 尺寸（可拖 / 记忆 / 双击复位） ---- */
  const [height, setHeight] = useState(loadReasonHeight)
  const heightRef = useRef(height)
  const [resizing, setResizing] = useState(false)
  const dragCleanup = useRef<(() => void) | null>(null)

  const beginResize = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = heightRef.current
    setResizing(true)
    /*
     * 监听同步挂 document（不是放 effect）：同一帧内先 pointerdown 再
     * pointermove 时，effect 还没跑，第一次移动会被丢掉（Terminal 里踩过）。
     */
    const onMove = (ev: PointerEvent): void => {
      const h = Math.min(maxReasonHeight(), Math.max(MIN_REASON_H, Math.round(startH + (ev.clientY - startY))))
      heightRef.current = h
      setHeight(h)
    }
    const finish = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      dragCleanup.current = null
      setResizing(false)
      saveReasonHeight(heightRef.current)
    }
    dragCleanup.current = finish
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  useEffect(() => () => dragCleanup.current?.(), [])

  /* ---- 跟随最新 / 回到最新 ---- */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const onBodyScroll = useCallback((): void => {
    const el = bodyRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stickRef.current = bottom
    setAtBottom((prev) => (prev === bottom ? prev : bottom))
  }, [])

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !open) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [shown, open])

  // 推理结束 → 自动折叠（除非用户在这期间手动开过）
  const wrappedRef = useRef(false)
  useEffect(() => {
    if (streaming) {
      wrappedRef.current = false
      return
    }
    if (!wrappedRef.current) {
      wrappedRef.current = true
      setManual((m) => m ?? false)
    }
  }, [streaming])

  if (!text.trim()) return null

  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null

  /**
   * 三种标题，别弄混：
   *   live       还在推理 →「推理中」
   *   有耗时     亲眼见过开始/结束 →「已推理 N 秒」
   *   无耗时     从会话历史加载的（没看到事件流）→「推理过程」
   */
  const label = live ? t('reason.now') : secs ? t('reason.done', { n: secs }) : t('reason.past')

  /*
   * 尾部淡入：只对**新增的最后一小段**做透明度过渡。
   *
   * ⚠️ 不能给整段套动画（历史文本会反复闪），也不能每帧给整段重建 DOM。
   *    做法是把尾部 ≤3 个字素单独放进一个 span，用长度做 key ——
   *    长度一变就重挂载，140ms 淡入；前面的稳定文本是同一个文本节点，不参与动画。
   *    超长文本（>4000 字）不做拆分，避免每帧 O(n) 的切分开销。
   */
  const { head, tail } = splitTail(shown, !!live && shown.length <= 4000)

  const toggleOpen = (): void => {
    if (!open) {
      stickRef.current = true
      setAtBottom(true)
    }
    setManual(!open)
  }

  const jumpToLatest = (): void => {
    const el = bodyRef.current
    stickRef.current = true
    setAtBottom(true)
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div
      className={`reason ${open ? 'open' : ''} ${live ? 'live' : ''} ${resizing ? 'resizing' : ''}`}
      data-testid="reasoning"
    >
      <button className="reason-head" onClick={toggleOpen} aria-expanded={open} data-testid="reasoning-toggle">
        {/*
         * 推理中用 spinner（它在动 = 模型在动），结束后换成 chevron
         * （一个静止的 spinner 会让人以为还在跑）。
         */}
        {live ? (
          <span className="reason-spin" aria-hidden>
            <Spinner />
          </span>
        ) : (
          <Icon name="chevron-right" size={12} className="chev" />
        )}
        <span className="reason-label">{label}</span>
        <span className="spacer" />
        {/* 折叠时给一行预览（用户不用展开就知道它在想什么） */}
        {!open && !live ? <span className="reason-peek">{firstLine(text)}</span> : null}
        {live ? <span className="cursor cursor-inline" /> : null}
      </button>

      {/*
       * 正文容器**始终挂载**：收起时高度过渡到 0。
       * 条件挂载会在收起动画开始前就把内容卸掉（尾部一闪而过），
       * 而且探针也无法区分「收起」与「没有推理」。
       */}
      <div
        className={`reason-body-wrap ${open ? 'open' : ''}`}
        style={{ '--reason-h': `${height}px` } as React.CSSProperties}
        aria-hidden={!open}
      >
        <div className="reason-body" data-testid="reasoning-body" ref={bodyRef} onScroll={onBodyScroll}>
          {head}
          {tail ? (
            <span className="reason-tail" key={shown.length}>
              {tail}
            </span>
          ) : null}
          {live ? <span className="cursor cursor-inline" /> : null}
        </div>
      </div>

      {/* 上滚后暂停跟随，给一个回到最新的入口（方案 4.4） */}
      {open && !atBottom ? (
        <button className="reason-jump" onClick={jumpToLatest} data-testid="reasoning-jump">
          {t('reason.jump')}
        </button>
      ) : null}

      {/* 底部把手：拖动改高度，双击复位 */}
      <div
        className="reason-grip"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        title={t('reason.resize')}
        aria-label={t('reason.resize')}
        data-testid="reasoning-grip"
        onPointerDown={beginResize}
        onDoubleClick={() => {
          heightRef.current = DEFAULT_REASON_H
          setHeight(DEFAULT_REASON_H)
          clearReasonHeight()
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 12
          let next = heightRef.current
          if (e.key === 'ArrowDown') next += step
          else if (e.key === 'ArrowUp') next -= step
          else if (e.key === 'Home') next = DEFAULT_REASON_H
          else return
          e.preventDefault()
          next = Math.min(maxReasonHeight(), Math.max(MIN_REASON_H, next))
          heightRef.current = next
          setHeight(next)
          saveReasonHeight(next)
        }}
      />
    </div>
  )
}

/** 把文本拆成「稳定部分 + 尾部若干字素」（尾部单独渲染以做淡入） */
function splitTail(s: string, enabled: boolean): { head: string; tail: string } {
  if (!enabled || s.length < 8) return { head: s, tail: '' }
  const units = toUnits(s)
  if (units.length < 4) return { head: s, tail: '' }
  const tail = units.slice(-3).join('')
  const head = units.slice(0, -3).join('')
  return { head, tail }
}

/**
 * ⚠️ memo 是必需的（与 TurnView 的 Paragraph 同一个原因）：
 * `groupIntoTurns` 每帧重建全部回合对象 → 所有 ReasoningCapsule 都会重渲染。
 * 比较字段就是它真正渲染依赖的全部东西。
 */
export const ReasoningCapsule = memo(
  ReasoningCapsuleImpl,
  (a, b) => a.text === b.text && a.ms === b.ms && a.live === b.live && a.turnLive === b.turnLive
)

/** 取第一行做预览（去掉 markdown 记号，太长的截断） */
function firstLine(s: string): string {
  const line = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? ''
  const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[*`_]/g, '')
  return plain.length > 60 ? plain.slice(0, 60) + '…' : plain
}

/**
 * 逐字显示（typewriter）—— 真·逐字，按**字素**推进。
 *
 * ── 为什么不是「一个字一个字 append」那么简单 ──
 * 模型送来的块可能一次几百字，如果固定「每帧 1 个字」，
 * 落后面会越来越大。所以用**基于时间**的速率，并让速率跟着积压量走：
 *
 *     每秒吐出 = 基础 90 字 + 积压 × 12（封顶 990 字/秒）
 *
 * 积压小时接近匀速（看得出来是一个个字在长）；积压大时自动加速，
 * 稳态落后约 1/12 秒 —— 远小于方案要求的 250ms 上限。
 *
 * ── 2026-09 改版要点（方案 4.4） ──
 *   · 按**字素**推进：`slice` 按 UTF-16 单元切会把 emoji / 组合字符劈成两半
 *     （显示成乱码方块），所以先在字素边界上推进；
 *   · 积压超过上限（约 1 秒的量）或从后台切回来 → **直接追齐**，
 *     不做「慢慢追赶」的动画；
 *   · 没有待显示文本时**停掉 rAF**（原来一直空转），有新文本再启动；
 *   · `prefers-reduced-motion` 时不用动画（`enabled=false` 直接给全文）。
 */
export function useTypewriter(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(enabled ? '' : text)
  /** 最新的完整文本（rAF 循环一直读它） */
  const target = useRef(text)
  /** 当前已经吐出来的**字素数** */
  const shownCount = useRef(0)
  /** 已切好的字素数组 + 它对应的原文（增量维护，避免整段重切） */
  const cache = useRef<{ text: string; units: string[] }>({ text: '', units: [] })
  const raf = useRef<number | null>(null)
  const lastTs = useRef(0)
  const carry = useRef(0)
  /** 连续空闲帧数：超过阈值就停掉循环 */
  const idle = useRef(0)

  /** 拿到 text 对应的字素数组（追加时只切新增部分） */
  const unitsFor = useCallback((next: string): string[] => {
    const c = cache.current
    if (next === c.text) return c.units
    if (next.startsWith(c.text) && c.text.length > 0) {
      const added = toUnits(next.slice(c.text.length))
      cache.current = { text: next, units: [...c.units, ...added] }
    } else {
      cache.current = { text: next, units: toUnits(next) }
    }
    return cache.current.units
  }, [])

  const render = useCallback(
    (count: number): void => {
      const units = cache.current.units
      shownCount.current = count
      setShown(units.slice(0, count).join(''))
    },
    []
  )

  /* 文本变化：对齐 / 增量，并在循环停掉时重启 */
  useEffect(() => {
    target.current = text
    if (!enabled) {
      cache.current = { text, units: toUnits(text) }
      shownCount.current = cache.current.units.length
      setShown(text)
      return
    }
    const units = unitsFor(text)
    if (units.length < shownCount.current) {
      /* 文本被替换成不相接的另一段（切会话 / 重新开始）→ 直接对齐 */
      cache.current = { text, units: toUnits(text) }
      render(cache.current.units.length)
      return
    }
    idle.current = 0
    if (raf.current === null) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled])

  const tick = useCallback(
    (ts: number): void => {
      const units = cache.current.units
      const total = units.length
      let count = shownCount.current

      if (total > count) {
        const backlog = total - count
        /*
         * 落后上限：积压超过约 1 秒的量就**直接追齐**。
         * 上限值取 250ms 的设计要求的宽松版（一秒的量）—— 正常速率下
         * 稳态落后只有 ~83ms，这条只在「切回窗口 / 大块突发」时生效。
         */
        if (backlog > 900) {
          count = total
        } else {
          const dt = lastTs.current ? Math.min(0.1, (ts - lastTs.current) / 1000) : 1 / 60
          lastTs.current = ts
          const cps = 90 + Math.min(900, backlog * 12)
          const perSecond = cps
          const add = perSecond * dt + carry.current
          const n = Math.floor(add)
          carry.current = add - n
          if (n > 0) count = Math.min(total, count + n)
        }
        if (count !== shownCount.current) {
          shownCount.current = count
          setShown(units.slice(0, count).join(''))
        }
        idle.current = 0
      } else {
        lastTs.current = 0
        idle.current += 1
        /* 空闲约 0.5 秒就停掉循环（不再空转 rAF） */
        if (idle.current > 30) {
          raf.current = null
          return
        }
      }

      raf.current = requestAnimationFrame(tick)
    },
    []
  )

  const start = useCallback((): void => {
    if (raf.current !== null) return
    lastTs.current = 0
    carry.current = 0
    idle.current = 0
    raf.current = requestAnimationFrame(tick)
  }, [tick])

  /* enabled 变化时起停循环 */
  useEffect(() => {
    if (!enabled) return
    start()
    return () => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
    }
  }, [enabled, start])

  /* 从后台切回来：积压可能很多，直接追齐（方案 4.4） */
  useEffect(() => {
    if (!enabled) return
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      const total = cache.current.units.length
      if (total > shownCount.current) render(total)
      start()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, render, start])

  return shown
}

/** 盲文 spinner —— 与输入框边框上那个同一套帧（pi 的 loader.js） */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (prefersReducedMotion()) return
    const id = setInterval(() => setI((v) => (v + 1) % SPIN.length), 80)
    return () => clearInterval(id)
  }, [])
  return <>{SPIN[i]}</>
}
