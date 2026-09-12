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
 * ② **推理中不折叠**：正在推理时胶囊是展开的（用户就是要「看着它在想」）。
 *    结束后自动折叠成一行，**保留开关**（用户要能再打开看）。
 *    所以这里的 open 是「用户手动覆盖」+「live 时强制展开」的组合。
 * ③ **没有推理就不显示**：`text` 为空直接返回 null —— 不占位、不留空壳。
 *
 * ⚠️ 与「思考档」的区别：思考档（thinkingLevel）是**设置**，
 *    告诉模型用多大强度推理；这里是**模型的推理输出本身**。
 *    模型可能在某轮完全不推理（off 档，或它决定直接回答）—— 那时不显示。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'

export function ReasoningCapsule({
  text,
  ms,
  live
}: {
  text: string
  /** 推理耗时（历史消息从会话里读不到，那时是 undefined） */
  ms?: number
  /** 是否还在流式推理 */
  live?: boolean
}) {
  const t = useT()
  /** 用户手动开关；null = 还没手动干预过（此时跟随 live） */
  const [manual, setManual] = useState<boolean | null>(null)
  /** 逐字显示用的文本（逐步追上 text） */
  const shown = useTypewriter(text, !!live)
  /* 展开态：用户手动覆盖优先，否则跟随 live（注意要在下面的 effect 之前算好，
     否则 effect 依赖的 `open` 还在 TDZ —— 实测直接整块渲染不出来） */
  const open = manual ?? !!live

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
    if (live) {
      wrappedRef.current = false
      return
    }
    // 从 live 变成不 live 的那一刻：折叠，并把控制权交给用户
    if (!wrappedRef.current) {
      wrappedRef.current = true
      setManual((m) => m ?? false)
    }
  }, [live])

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

/** 取第一行做预览（去掉 markdown 记号，太长的截断） */
function firstLine(s: string): string {
  const line = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? ''
  const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[*`_]/g, '')
  return plain.length > 60 ? plain.slice(0, 60) + '…' : plain
}

/* ------------------------------------------------------------------ */

/**
 * 逐字显示（typewriter）。
 *
 * ── 为什么不是「一个字一个字 append」那么简单 ──
 * 模型送来的块可能一次几百字，如果固定「每帧 1 个字」，
 * 落后面会越来越大（最后显示的字比真实进度晚十几秒）。
 * 所以速率跟着**积压量**走：
 *
 *     每帧吐出的字数 = clamp(积压 / 8, 1, 24)
 *
 * 积压小时就是逐字（1 字/帧 ≈ 60 字/秒，接近人的阅读节奏）；
 * 积压大时自动加速，稳定在落后约 8 帧（~130ms）。
 *
 * ── 为什么要 rAF 而不是 setInterval ──
 * rAF 跟着显示器刷新（60/120Hz 都合适），而且窗口不可见时自动停 ——
 * 不会在后台空转。也顺便避免「组件卸载后还在 setState」。
 *
 * `enabled=false`（历史消息）时直接返回全文 —— 翻旧会话不该看打字动画。
 */
export function useTypewriter(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(enabled ? '' : text)
  const target = useRef(text)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    target.current = text
    if (!enabled) {
      setShown(text)
      return
    }
    // 已经追上（或文本被替换成更短的）→ 直接对齐，避免动画倒放
    setShown((cur) => (text.length <= cur.length || !text.startsWith(cur) ? text : cur))

    if (raf.current !== null) return
    const tick = (): void => {
      let done = false
      setShown((cur) => {
        const tgt = target.current
        if (!tgt.startsWith(cur)) return tgt
        const backlog = tgt.length - cur.length
        if (backlog <= 0) {
          done = true
          return cur
        }
        const step = Math.max(1, Math.min(24, Math.round(backlog / 8)))
        return tgt.slice(0, cur.length + step)
      })
      if (done) {
        raf.current = null
        return
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
    // text 变化时重新起 tick；enabled 切换同理
  }, [text, enabled])

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
