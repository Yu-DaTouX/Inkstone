import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { groupIntoTurns } from '../../../../shared/turns'

/**
 * 对话导航轨 —— 消息流左侧那一条。
 *
 * 每一格对应一轮**用户发起的对话**：
 *   · 一眼看出这个会话有多长（不用滚到底）
 *   · 看得出当前读到哪（高亮那一格）
 *   · 悬停展开这一轮的详情 + 点击跳转
 *
 * ── 为什么重写了（用户报的问题）──
 * 「现在的范围太小且过于密集导致选择起来很困难」—— 旧实现是
 * 3px 高的横线、间距 9px，一格的可点区域就是那条线本身（14×3px）。
 * 20 轮以上时，鼠标要精准落在 3px 的横线上才能选中，这是折磨。
 *
 * 改法：
 *   ① **命中区与视觉分离** —— 每格是一个 padding 撑起来的按钮
 *      （约 40×15px 的点按区），里面的 `.outline-bar` 才是那条细线。
 *      视觉上还是「一条条线」，但手不用那么准。
 *   ② **悬停就展开那一格** —— 鼠标停在哪一格，哪一格的线**在轨道内**
 *      长高变宽（不是一个和被指的那格错位的预览卡）。
 *   ③ 预览卡**锚在被指的那一格旁边**（旧的实现固定在轨道垂直中心，
 *      指第 1 轮却在屏幕中间弹框，指的是哪一格全靠猜）。
 *   ④ 间距 9 → 6，但每格命中区 15px 高 —— 总占用差不多，
 *      可点性高了一倍以上。
 *
 * 位置用 flex 均分而不是按像素排：消息高度差异极大（一句话 vs 一段代码），
 * 按高度排会让刻度全挤在一起。
 */
export function ConversationOutline() {
  const t = useT()
  const messages = useStore((s) => s.messages)
  const scrollToTurn = useStore((s) => s.scrollToTurn)
  const streamingId = useStore((s) => (s.session?.isStreaming ? s.messages[s.messages.length - 1]?.id : undefined))
  const [hover, setHover] = useState<number | null>(null)

  /**
   * 每一轮：用**和滚动跳转同一个分组函数**（groupIntoTurns）算出来。
   *
   * ⚠️ 这里以前是自己从 messages 里数 `role === 'user'` 得到的数组。
   *    两者目前数量一致，但那是**巧合**（都等于用户消息数）——
   *    只要分组逻辑一变（例如把连续用户消息合并成一轮、或把 bash 算进去），
   *    导航轨的下标就会与 scrollToTurn 的下标错位，表现为
   *    「点第 N 格跳到第 N-1 轮」。两套口径必须只有一个真源。
   */
  const turns = useMemo(() => {
    const all = groupIntoTurns(messages, streamingId)
    return all
      .filter((x) => x.kind === 'user')
      .map((x, i) => ({
        user: x.msg.text,
        assistant: assistantTextAfter(all, all.indexOf(x)),
        msgId: x.id,
        index: i
      }))
  }, [messages, streamingId])

  /**
   * 当前高亮哪一格。
   *
   * ⚠️ 以前是 `round(scrollProgress * (n-1))` —— 用滚动百分比**线性**估算轮次。
   *    但每轮高度差异很大（一句话 vs 一段代码），线性估算必然偏，
   *    用户看到的就是「我点第 5 格，标记却跑到第 4 格」（定位不准）。
   *    现在按**真实几何**算：找到顶边在视口内/之上的最接近的那一轮。
   */
  const [active, setActive] = useState(0)
  /** 点击后钉住的下标（因为最后几格滚不动，靠钉住才能给出正确反馈） */
  const pinned = useRef<number | null>(null)
  /** 我们自己发起的滚动在多久内不算「用户自己滚」 */
  const programmaticAt = useRef(0)

  const activeFromGeometry = (): number => {
    const box = document.querySelector('.stream')
    if (!box) return 0
    const boxTop = box.getBoundingClientRect().top
    /*
     * 拿 DOM 里真实存在的回合（虚拟化时只有可见的那几个）。
     * 用 data-turn-id 匹配到「第几个用户回合」：
     *   回合 id 就是用户消息 id，而导航轨的每一格也存了 msgId。
     */
    let best = 0
    let bestTop = -Infinity
    for (const el of document.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      const id = el.dataset.turnId
      const idx = turns.findIndex((x) => x.msgId === id)
      if (idx < 0) continue
      const top = el.getBoundingClientRect().top - boxTop
      // 顶边已经越过视口顶部的那一轮里，最靠下的那个 = 当前在读的
      if (top <= 8 && top > bestTop) {
        bestTop = top
        best = idx
      }
    }
    return best
  }

  /* 滚动时按几何重算（rAF 节流）。自己发起的滚动在 300ms 内不解除钉住 */
  useEffect(() => {
    const box = document.querySelector('.stream')
    if (!box) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (Date.now() - programmaticAt.current < 300) return
        pinned.current = null
        setActive(activeFromGeometry())
      })
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      box.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, turns.map((x) => x.msgId).join(',')])

  /** 切会话 / 首次渲染时也同步一次 */
  useEffect(() => {
    if (pinned.current !== null) return
    setActive(activeFromGeometry())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length])

  const track = useRef<HTMLDivElement>(null)
  /** 被指的那一格在轨道内的相对位置（0~1），预览卡按它定位 */
  const [hoverRatio, setHoverRatio] = useState(0)

  /**
   * 导航轨的横向位置**由 JS 实测**（用户要求：随窗口缩放）。
   *
   * 纯 CSS 做不到：
   *   · 内容列是居中限宽的，刻度要贴在它左边；
   *   · 窗口窄时内容列占满，左边只剩内边距（24px）——
   *     而悬停时刻度要长到 34px，CSS 里没有“有边距就放外边、
   *     没边距就夹进内边距”这种分支。
   * 用 `textLeft - 44`（刻度列宽 + 让位）算，两种情形都对，
   * 而且窗口一变就重算。
   */
  const root = useRef<HTMLDivElement>(null)
  const [leftPx, setLeftPx] = useState<number | null>(null)
  useLayoutEffect(() => {
    const host = root.current?.offsetParent as HTMLElement | null
    if (!host) return

    const OUTLINE_W = 44
    /*
     * 取当前内容列的元素。
     *
     * ⚠️ 不能只找 `.stream-inner`：虚拟化的长会话走 `.stream-row`，
     *    根本没有 `.stream-inner` —— 旧实现此时直接 return，
     *    leftPx 永远是 null，导航轨就钉死在 CSS 的 left:0（用户报的错位）。
     *    两者的内边距与 max-width 完全一致，量哪一个都行。
     */
    const innerOf = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('.stream-inner, .stream-row')

    const measure = (): void => {
      const inner = innerOf()
      if (!inner) return
      const hb = host.getBoundingClientRect()
      const ib = inner.getBoundingClientRect()
      // 正文左缘 = 内容列左缘 + 它自己的左内边距（--sp-5 = 24）
      const textLeft = ib.left + 24
      setLeftPx(Math.max(0, Math.round(textLeft - hb.left - OUTLINE_W)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    /* 观察内容列本身：改对话宽度 / 收放面板时它的宽度都会变 */
    const inner0 = innerOf()
    if (inner0) ro.observe(inner0)
    window.addEventListener('resize', measure)
    /* 设置里改对话宽度后，App 会派这个事件（虚拟化时没有可观察的常驻元素） */
    window.addEventListener('yan:stream-width', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('yan:stream-width', measure)
    }
  }, [turns.length])

  /**
   * 悬停时记下这一格在轨道里的相对位置。
   *
   * 用 `useLayoutEffect` 而不是在事件里直接算 —— 因为 CSS 会在 hover 后
   * 把那一格长高（.outline-hit 的 height 变化），布局量完才是最终位置。
   */
  useLayoutEffect(() => {
    if (hover === null) return
    const el = track.current?.querySelectorAll<HTMLElement>('[data-testid="outline-tick"]')[hover]
    const box = track.current
    if (!el || !box) return
    const a = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (b.height <= 0) return
    setHoverRatio(Math.min(1, Math.max(0, (a.top + a.height / 2 - b.top) / b.height)))
  }, [hover, turns.length])

  // 轮数太少时不显示（2-3 格既没用又占地方）
  if (turns.length < 3) return null

  return (
    <div
      className="outline"
      ref={root}
      style={leftPx != null ? { left: `${leftPx}px` } : undefined}
      data-testid="outline"
      role="navigation"
      aria-label={t('outline.label')}
    >
      <div className="outline-track" ref={track}>
        {turns.map((turn, i) => (
          <button
            key={turn.msgId}
            className={`outline-hit ${i === active ? 'on' : ''} ${i === hover ? 'hover' : ''}`}
            /* 用 mouseover/mouseout 而不是 mouseenter/mouseleave：
               React 的 enter/leave 是从 mouseover/mouseout 合成的，
               直接派发 enter 不触发；over/out 是原生冒泡事件，行为可预测。 */
            onMouseOver={() => setHover(i)}
            onMouseOut={() => setHover((h) => (h === i ? null : h))}
            onFocus={() => setHover(i)}
            onBlur={() => setHover((h) => (h === i ? null : h))}
            onClick={() => {
              /*
               * 点击时**钉住**高亮。
               * 为什么需要：最后几格的目标回合已经很靠底，滚动被夹在
               * 最大 scrollTop 上（内容不够了）—— 滚动几乎不动，
               * 几何重算会把高亮留在原来那格，用户看到的就是
               * 「点了第 10 格，标记还在第 9 格」（他报的「跳到上一个」）。
               * 钉住之后标记跟着点击走，用户至少知道自己的操作生效了。
               */
              pinned.current = i
              programmaticAt.current = Date.now()
              setActive(i)
              scrollToTurn(i)
            }}
            data-testid="outline-tick"
            aria-label={t('outline.tick', { n: i + 1 })}
          >
            <span className="outline-bar" />
          </button>
        ))}
      </div>

      {hover !== null ? (
        <OutlinePreview
          turn={turns[hover]}
          n={hover + 1}
          total={turns.length}
          ratio={hoverRatio}
        />
      ) : null}
    </div>
  )
}

/**
 * 取某一轮后面的助手回复正文（用于预览摘要）。
 * 找不到就回空 —— 用户刚发完还没回答时就是这样。
 */
function assistantTextAfter(all: ReturnType<typeof groupIntoTurns>, userIdx: number): string {
  const next = all[userIdx + 1]
  if (!next || next.kind !== 'assistant') return ''
  /* assistant 回合把正文拆成了 response（回复）与 commentary（解说），预览要的是回复 */
  /* response 是单个 TurnText（不是数组）—— 多段回复在分组时已拼成一段 */
  return next.response?.text ?? ''
}

/**
 * 悬停预览：一轮的**摘要** —— 一行标题 + 三行回答。
 *
 * ── 为什么改（用户反馈）──
 * 上一版把用户的**整段原话**铺在卡片里（clamp 5 行）+ 回答开头（clamp 5 行）。
 * 问题：用户的提问常常是一整段带路径、带报错、带换行的话，铺出来是一块杂讯，
 * 卡片的目的是「让我认出这是哪一轮」，不是「让我重读一遍原话」。
 *
 * 现在：
 *   · 标题 = 从用户原话里提炼的一行短句（第一个句子，≤ 22 字）
 *   · 正文 = AI 回答压成**三行**（`-webkit-line-clamp: 3`）
 *   标题用强调色 + 稍大字号，回答用灰色、行高紧 —— 一眼分清哪个是「问」哪个是「答」。
 *
 * `ratio` 是被指那一格在轨道内的垂直位置（0~1）。
 * 卡片按它对齐，而不是固定居中 —— 否则指第 1 轮却在屏幕中间弹框。
 */
function OutlinePreview({
  turn,
  n,
  total,
  ratio
}: {
  turn: { user: string; assistant: string }
  n: number
  total: number
  ratio: number
}) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)

  /**
   * 挂载后量一次：把卡片对齐到被指的那一格。
   *
   * ⚠️ `top` 是相对 `.outline` 容器的，不是相对视口 ——
   *   卡片是 absolute，它的包含块是 .outline（也是 absolute）。
   *   上一版直接用视口坐标赋值，于是卡片被推到下面一屏（探针实测偏 288px）。
   */
  useLayoutEffect(() => {
    const el = card.current
    const host = el?.offsetParent as HTMLElement | null
    const anchor = el?.parentElement?.querySelector<HTMLElement>('.outline-track')
    if (!el || !host || !anchor) return

    const a = anchor.getBoundingClientRect()
    const hb = host.getBoundingClientRect()
    const h = el.offsetHeight

    // 视口里的目标中点 → 换成宿主坐标系里的 top
    const targetMid = a.top + ratio * a.height
    let top = targetMid - hb.top - h / 2

    // 夹进宿主盒子里（不要跑到标题栏上面或窗口外面）
    const min = 4
    const max = Math.max(min, hb.height - h - 4)
    if (top < min) top = min
    if (top > max) top = max
    el.style.top = `${Math.round(top)}px`
  }, [ratio, n])

  return (
    <div className="outline-preview" ref={card} data-testid="outline-preview">
      <div className="op-head">
        <span className="op-n">
          {n} / {total}
        </span>
        <span className="spacer" />
        <span className="op-hint">{t('outline.click')}</span>
      </div>

      {/* 标题：用户那一问的短摘要 */}
      <div className="op-title" data-testid="outline-preview-title" title={clean(turn.user, 400)}>
        {makeTitle(turn.user)}
      </div>

      {/* 正文：AI 回答的三行预览 */}
      {turn.assistant ? (
        <div className="op-answer" data-testid="outline-preview-answer">
          {clean(turn.assistant, 600)}
        </div>
      ) : (
        <div className="op-empty">{t('outline.noAnswer')}</div>
      )}
    </div>
  )
}

/**
 * 把用户原话提炼成一个标题。
 *
 * 为什么要提炼而不是截断：用户的话常常以路径 / 报错 / 图片名开头：
 *   `C:\Users\...\1.png白色背景下 渲染有问题 右边栏的任务没有...`
 *   截断只会得到一串路径。这里改成先**去掉开头的路径/文件名**，
 *   再取**第一个句子**，最后才截到 22 字。
 */
function makeTitle(s: string): string {
  let t = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[<>{}[\]|]/g, ' ')
    // 去掉统一前缀的路径（Windows 盘符 / POSIX / UNC）
    .replace(/[A-Za-z]:[\\/][^\s]*/g, ' ')
    .replace(/(?:^|\s)[~/][\w./-]{4,}/g, ' ')
    // 去掉纯文件名（带扩展名的那种）
    .replace(/\S+\.(png|jpe?g|gif|webp|svg|ts|tsx|js|json|md|css|html|txt|log|py|rs|go)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!t) t = s.replace(/\s+/g, ' ').trim()

  // 取第一个句子：中文句号/问号/叹号，或英文标点，或换行
  const m = /^[^。！？!?\n]{1,60}/.exec(t)
  if (m) t = m[0].trim()

  // 去掉结尾的标点与连接词
  t = t.replace(/[，,、；;：:。.]+$/, '').trim()

  return t.length > 22 ? `${t.slice(0, 22)}…` : t || '（无标题）'
}

/** 预览里不需要 markdown 语法噪音，压成纯文本并截断 */
function clean(s: string, max = 220): string {
  const plain = s
    .replace(/```[\s\S]*?```/g, ' […] ')
    .replace(/`([^`]*)`/g, '$1')
    // 保留换行 —— 三行回答是按行 clamp 的，压成一长行就变成「一整段的开头」
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^[*_#>|]+\s*/gm, '')
    .trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}
