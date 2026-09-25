/**
 * 推理流（2026-09-23 用户决定的最终形态）。
 *
 * **默认折叠成一行**，只显示模型原文里的最新一句（正在成形的末句也算）。
 * 单击头部就在**当前聊天位置**展开完整原文，限高 `min(70vh, 620px)` 并内部滚动；
 * 展开态在头部**同一个按钮**上收起。
 *
 * ── 边界 ──
 * ① 开合只由用户动作驱动：流式期间不自动弹开，回合结束后**也不自动收起**
 *    （旧「整轮结束自动折叠」已废止）。`live` / `turnLive` 只影响标题与光标。
 * ② 展开后仅在仍贴底时跟随新增内容；用户上滚阅读期间位置保持，新流不抢回底部。
 * ③ `text` 为空直接返回 null —— 不占位、不留空壳。
 * ④ 模型原文是唯一真源：预览只做展示层截取，不改写文本、不注入提示词。
 * ⑤ 逐字按**字素**推进（中文标点 / emoji / 组合字符不被切开），尾部 140ms 淡入；
 *    `prefers-reduced-motion` 直接给全文，且**运行中切换偏好也生效**。
 * ⑥ 展开状态不跨会话：上层给每段推理的是带消息 id 的 key
 *    （`shared/turns.ts` 的 `${msgId}#segN`），切会话即重挂组件。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { ThinkingOrbIndicator } from './ThinkingOrbIndicator'

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
const SENTENCE_SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'sentence' })
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
   * 只影响逐字推进与光标，**不控制开合**（开合是用户动作）。
   */
  turnLive?: boolean
}) {
  const t = useT()
  /** 正文是否展开全文。默认 false = 一行最新句预览（不跟流式状态自动变化）。 */
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  /** 没有回合级信号时（历史消息）退回到单段信号，仅用于逐字启停 */
  const streaming = turnLive ?? live
  /** 逐字显示用的文本（逐步追上 text）；减少动态效果时直接给全文 */
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const shown = useTypewriter(text, !!streaming && !reduced)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  /* 展开时仅在用户仍贴底阅读的情况下跟随流式更新。 */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && open && followRef.current) el.scrollTop = el.scrollHeight
  }, [shown, open])

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
    const next = !open
    setOpen(next)
    followRef.current = true
    /*
     * 展开后把自己滚进可视区（用户：「展开这个窗口的时候会被输入框挡住」）。
     *
     * 这个块长在消息流里，展开后会变高；如果它本身就贴着流底部，
     * 多出来的那一截会落在输入框后面 —— 用户看到的就是「被挡住了」。
     * `block: 'nearest'` 只动必要的量：已经看得到就不滚，避免每次展开
     * 都把长会话猛地拉到底。
     */
    if (next) {
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ block: 'nearest' })
      })
    }
  }

  return (
    <div
      ref={rootRef}
      className={`reason ${open ? 'open' : ''} ${live ? 'live' : ''}`}
      data-layout="reasoning"
      data-testid="reasoning"
    >
      <button className="reason-head" onClick={toggleOpen} aria-expanded={open} data-testid="reasoning-toggle">
        {/*
         * 推理中用 Orb（它在动 = 模型在动），结束后换成 chevron
         * （一个静止的 spinner 会让人以为还在跑）。
         */}
        {live ? (
          <span className="reason-spin" aria-hidden>
            <ThinkingOrbIndicator state="solving" />
          </span>
        ) : (
          <Icon name="chevron-right" size={12} className="chev" />
        )}
        <span className="reason-label">{label}</span>
        <span className="spacer" />
        {/* 默认预览原文最新一句（长句保留尾端，见 peekText）；单击头部在当前位置打开全文。
            dir 分工：外层 rtl 让溢出发生在左侧（省略号在左、尾端贴右），
            内层 ltr 隔离 bidi，中英混排的顺序不会被重排。 */}
        {!open ? (
          <span className="reason-peek" data-testid="reasoning-preview" dir="rtl">
            <span dir="ltr">{peekText(latestSentence(shown))}</span>
          </span>
        ) : null}
        {live ? <span className="cursor cursor-inline" /> : null}
      </button>

      <div
        ref={bodyRef}
        className={`reason-body ${open ? 'open' : ''}`}
        aria-hidden={!open}
        hidden={!open}
        onScroll={(event) => {
          const el = event.currentTarget
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
        }}
      >
        <div data-testid="reasoning-body">
          {head}
          {tail ? (
            <span className="reason-tail" key={shown.length}>
              {tail}
            </span>
          ) : null}
          {live ? <span className="cursor cursor-inline" /> : null}
        </div>
      </div>
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

/** 展示层取最新一句；断行视作句界，未完成的末句优先保留。 */
export function latestSentence(s: string): string {
  const lines = s.split('\n').map((line) => line.trim()).filter(Boolean)
  const line = lines.at(-1) ?? ''
  if (!line) return ''
  const sentences = SENTENCE_SEGMENTER
    ? [...SENTENCE_SEGMENTER.segment(line)].map((part) => part.segment.trim()).filter(Boolean)
    : fallbackSentences(line)
  const candidate = sentences.at(-1) ?? line
  return candidate.replace(/^[#>*\-\s]+/u, '')
}

/**
 * 单行预览的**尾端**保留：一行放不下整句时截掉的是**开头**（尾端才是最新内容）。
 * 按字素切，不把 emoji / 组合字符劈开；只影响预览，正文仍是模型原文。
 *
 * 这是 CSS 之外的一道兜底：`.reason-peek` 用外层 rtl 把溢出挤到左边，
 * 但它依赖内层 `dir="ltr"` 隔离 bidi；这条长度上限保证即使隔离失效，
 * 窄窗下也看不到“截掉尾端”（见 DESIGN V-2a）。
 */
const PEEK_UNITS = 60
export function peekText(s: string): string {
  const units = toUnits(s)
  if (units.length <= PEEK_UNITS) return s
  return '…' + units.slice(-PEEK_UNITS).join('')
}

/** Intl.Segmenter fallback: group punctuation and closing quotes with the sentence. */
function fallbackSentences(text: string): string[] {
  const units = toUnits(text)
  const result: string[] = []
  let start = 0
  for (let i = 0; i < units.length; i++) {
    const stop = /[。！？!?]/u.test(units[i]) || (units[i] === '.' && (i === units.length - 1 || /\s/u.test(units[i + 1])))
    if (!stop) continue
    let end = i + 1
    while (end < units.length && /[。！？!?]/u.test(units[end])) end++
    while (end < units.length && /["'”’）)】\]}]/u.test(units[end])) end++
    result.push(units.slice(start, end).join(''))
    start = end
    i = end - 1
  }
  if (start < units.length) result.push(units.slice(start).join(''))
  return result
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
