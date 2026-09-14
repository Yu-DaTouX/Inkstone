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
 *    一个回合可能「思考 → 调工具 → 再思考 → 回复」，第一段 thinking_end
 *    时工具还在跑，那时折叠就会「推理只显示几秒、一执行工具就消失了」（用户报的）。
 *    结束后自动折叠成一行，**保留开关**（用户要能再打开看）。
 *    所以这里的 open 是「用户手动覆盖」+「回合进行中强制展开」的组合。
 * ③ **没有推理就不显示**：`text` 为空直接返回 null —— 不占位、不留空壳。
 *
 * ⚠️ 与「思考档」的区别：思考档（thinkingLevel）是**设置**，
 *    告诉模型用多大强度推理；这里是**模型的推理输出本身**。
 *    模型可能在某轮完全不推理（off 档，或它决定直接回答）—— 那时不显示。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'

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
   * 推理窗口的**展开与折叠时机**跟它走，不跟单段推理走 ——
   * 否则「思考 → 调工具」时第一段推理会在工具刚跑起来就被折叠。
   */
  turnLive?: boolean
}) {
  const t = useT()
  /** 用户手动开关；null = 还没手动干预过（此时跟随 turnLive） */
  const [manual, setManual] = useState<boolean | null>(null)
  /** 没有回合级信号时（历史消息）退回到单段信号 */
  const streaming = turnLive ?? live
  /** 逐字显示用的文本（逐步追上 text） */
  const shown = useTypewriter(text, !!streaming)
  /* 展开态：用户手动覆盖优先，否则跟随「回合是否进行中」。
     注意要在下面的 effect 之前算好，否则 effect 依赖的 `open` 还在 TDZ ——
     实测直接整块渲染不出来。 */
  const open = manual ?? !!streaming

  /*
   * 固定大小的推理窗口里要自动跟随最新（用户要求「信息在里面滚动显示」）。
   * 但不能无脑 scrollTop=scrollHeight —— 用户往上翻想看前面在想什么时，
   * 每一次新字到达都会把他拽回底部。所以记一个「是否粘着底部」：
   * 只有本来就在底部（或用户自己滑回底部）才跟随。
   */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const onBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

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
    // 从「回合进行中」变成「回合结束」的那一刻：折叠，并把控制权交给用户
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

  return (
    <div className={`reason ${open ? 'open' : ''} ${live ? 'live' : ''}`} data-testid="reasoning">
      <button
        className="reason-head"
        onClick={() => {
          // 重新打开时回到粘底（用户想看的是最新进度）
          if (!open) stickRef.current = true
          setManual(!open)
        }}
        aria-expanded={open}
        data-testid="reasoning-toggle"
      >
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
      {open ? (
        <div
          className="reason-body"
          data-testid="reasoning-body"
          ref={bodyRef}
          onScroll={onBodyScroll}
        >
          {shown}
          {live ? <span className="cursor cursor-inline" /> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * ⚠️ memo 是必需的（与 TurnView 的 Paragraph 同一个原因）：
 *
 * `groupIntoTurns` 每帧重建全部回合对象 → 所有 ReasoningCapsule 都会
 * 重渲染。而它内部有 `useTypewriter`（rAF 循环 + setState），
 * 每帧重建一次会把历史推理的逐字动画重新起一遍。
 *
 * 比较字段就是它真正渲染依赖的全部东西：文本、耗时、两个「是否在跑」信号。
 */
export const ReasoningCapsule = memo(
  ReasoningCapsuleImpl,
  (a, b) =>
    a.text === b.text && a.ms === b.ms && a.live === b.live && a.turnLive === b.turnLive
)

/** 取第一行做预览（去掉 markdown 记号，太长的截断） */
function firstLine(s: string): string {
  const line = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? ''
  const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[*`_]/g, '')
  return plain.length > 60 ? plain.slice(0, 60) + '…' : plain
}



/**
 * 逐字显示（typewriter）—— 真·逐字。
 *
 * ── 为什么不是「一个字一个字 append」那么简单 ──
 * 模型送来的块可能一次几百字，如果固定「每帧 1 个字」，
 * 落后面会越来越大（最后显示的字比真实进度晚十几秒）。
 * 所以用**基于时间**的速率，并且让速率跟着积压量走：
 *
 *     每秒吐出 = 基础 90 字 + 积压 × 12（封顶 990 字/秒）
 *
 * 积压小时是接近匀速的 90 字/秒（人眼看得出来是一个个字在长）；
 * 积压大时自动加速，稳定在落后极短的时间，不会越落越远。
 *
 * ⚠️ 之前是「每帧按 backlog/8 取整、最多 24 字」——
 *    backlog 上百字时一帧就吐十几个，视觉上是「一块块地跳」，
 *    用户要的逐字感反而没了。而且它随刷新率变化（120Hz 比 60Hz 快一倍）。
 *    现在按**真实时间**算，跟刷新率无关，而且带小数累加器，
 *    低积压时每帧就是 1-2 个字。
 *
 * ── 为什么用 rAF 而不是 setInterval ──
 * rAF 跟着显示器刷新（60/120Hz 都合适），而且窗口不可见时自动停 ——
 * 不会在后台空转。也顺便避免「组件卸载后还在 setState」。
 *
 * `enabled=false`（历史消息）时直接返回全文 —— 翻旧会话不该看打字动画。
 */
export function useTypewriter(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(enabled ? '' : text)
  /** 最新的完整文本（rAF 循环一直读它，不再因为文本变化重启循环） */
  const target = useRef(text)
  /** 当前已经吐出来的文本（rAF 循环内的同步真源，避免 stale closure） */
  const shownRef = useRef(shown)
  const raf = useRef<number | null>(null)
  /** 上一帧的时间戳（算 dt）；0 = 还没开始 / 刚追平 */
  const lastTs = useRef(0)
  /** 小数累加器：低积压时一帧不足 1 字就先攒着，下一帧补上 */
  const carry = useRef(0)

  useEffect(() => {
    target.current = text
    if (!enabled) {
      shownRef.current = text
      setShown(text)
      return
    }
    /*
     * 文本被**替换**成不相接的另一段（切会话 / 重新开始）→ 直接对齐，
     * 避免从旧的错误前缀开始动画。追加（startsWith 成立且更长）则不动，
     * 让 rAF 继续把它吐出来。
     */
    if (!text.startsWith(shownRef.current) || text.length < shownRef.current.length) {
      shownRef.current = text
      setShown(text)
    }
  }, [text, enabled])

  /*
   * 稳定的 rAF 循环：只在 enabled 变化时起停。
   * 不再把 text 放进依赖里 —— 之前每来一个 delta 就 cancel + requestAnimationFrame，
   * 既抖又让「上一帧算好的 dt」丢掉。
   */
  useEffect(() => {
    if (!enabled) return
    lastTs.current = 0
    carry.current = 0

    const tick = (ts: number): void => {
      const tgt = target.current
      let cur = shownRef.current

      if (!tgt.startsWith(cur)) {
        cur = tgt
      } else {
        const backlog = tgt.length - cur.length
        if (backlog <= 0) {
          lastTs.current = 0
        } else {
          const dt = lastTs.current ? Math.min(0.1, (ts - lastTs.current) / 1000) : 1 / 60
          lastTs.current = ts
          const cps = 90 + Math.min(900, backlog * 12)
          const add = cps * dt + carry.current
          const n = Math.floor(add)
          carry.current = add - n
          if (n > 0) cur = tgt.slice(0, cur.length + n)
        }
      }

      if (cur !== shownRef.current) {
        shownRef.current = cur
        setShown(cur)
      }
      raf.current = requestAnimationFrame(tick)
    }

    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
    }
  }, [enabled])

  return shown
}

/** 盲文 spinner —— 与输入框边框上那个同一套帧（pi 的 loader.js） */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = setInterval(() => setI((v) => (v + 1) % SPIN.length), 80)
    return () => clearInterval(id)
  }, [])
  return <>{SPIN[i]}</>
}
